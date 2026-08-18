import {eq} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {hashToken} from "./auth";
import {legacyIdentityClaims} from "./db/d1-schema";
import {completeDurableObjectCleanup, recordLegacyIdentity} from "./identity-lifecycle";
import {getPairedMachineCount} from "./pairing";
import type {UserDurableObject} from "./user-do";

interface LegacyClaimRow {
	tokenHash: string;
	legacyUserId: string;
	userId: string;
	status: "pending" | "complete";
}

export type LegacyIdentityClaimResult =
	| {status: "claimed"; alreadyClaimed: boolean}
	| {status: "not_found"}
	| {status: "conflict"; message: string};

async function findClaim(database: D1Database, tokenHash: string): Promise<LegacyClaimRow | null> {
	const rows = await drizzle(database)
		.select({
			tokenHash: legacyIdentityClaims.tokenHash,
			legacyUserId: legacyIdentityClaims.legacyUserId,
			userId: legacyIdentityClaims.userId,
			status: legacyIdentityClaims.status,
		})
		.from(legacyIdentityClaims)
		.where(eq(legacyIdentityClaims.tokenHash, tokenHash));
	return rows[0] ?? null;
}

async function reserveClaim(
	database: D1Database,
	tokenHash: string,
	destinationUserId: string,
): Promise<LegacyClaimRow | null> {
	const now = Date.now();
	const legacyIdentity = await database
		.prepare(
			"SELECT machine.user_id, machine.created_at FROM machine_tokens AS machine " +
				"LEFT JOIN user AS owner ON owner.id = machine.user_id " +
				"WHERE machine.token_hash = ? AND machine.credential_type = 'legacy_app' " +
				"AND machine.revoked_at IS NULL AND (owner.id IS NULL OR NOT EXISTS " +
				"(SELECT 1 FROM account WHERE account.user_id = owner.id))",
		)
		.bind(tokenHash)
		.first<{created_at: number; user_id: string}>();
	if (legacyIdentity === null) {
		return null;
	}
	await recordLegacyIdentity(database, legacyIdentity.user_id, legacyIdentity.created_at);
	await database
		.prepare(
			"INSERT INTO legacy_identity_claims " +
				"(token_hash, legacy_user_id, user_id, status, created_at) " +
				"SELECT machine.token_hash, machine.user_id, ?, 'pending', ? " +
				"FROM machine_tokens AS machine " +
				"LEFT JOIN user AS owner ON owner.id = machine.user_id " +
				"WHERE machine.token_hash = ? AND machine.credential_type = 'legacy_app' " +
				"AND machine.revoked_at IS NULL " +
				"AND (owner.id IS NULL OR NOT EXISTS " +
				"(SELECT 1 FROM account WHERE account.user_id = owner.id)) " +
				"AND EXISTS (SELECT 1 FROM identity_lifecycles AS lifecycle " +
				"WHERE lifecycle.identity_id = machine.user_id AND lifecycle.identity_type = 'legacy' " +
				"AND lifecycle.owner_user_id IS NULL AND lifecycle.deleted_at IS NULL " +
				"AND lifecycle.expires_at > ?) " +
				"ON CONFLICT DO NOTHING",
		)
		.bind(destinationUserId, now, tokenHash, now)
		.run();
	return findClaim(database, tokenHash);
}

async function completeD1Claim(database: D1Database, claim: LegacyClaimRow, destinationUserId: string): Promise<void> {
	const claimedAt = Date.now();
	await database.batch([
		database
			.prepare(
				"UPDATE machine_tokens SET user_id = ?, " +
					"revoked_at = CASE WHEN credential_type = 'legacy_app' " +
					"THEN coalesce(revoked_at, ?) ELSE revoked_at END " +
					"WHERE user_id = ?",
			)
			.bind(destinationUserId, claimedAt, claim.legacyUserId),
		database
			.prepare("UPDATE pairing_codes SET user_id = ? WHERE user_id = ?")
			.bind(destinationUserId, claim.legacyUserId),
		database
			.prepare(
				"UPDATE legacy_identity_claims SET status = 'complete', claimed_at = ? " +
					"WHERE token_hash = ? AND user_id = ? AND status = 'pending'",
			)
			.bind(claimedAt, claim.tokenHash, destinationUserId),
		database
			.prepare(
				"UPDATE identity_lifecycles SET owner_user_id = ?, claimed_at = ?, " +
					"deletion_requested_at = ?, deleted_at = ? " +
					"WHERE identity_id = ? AND identity_type = 'legacy'",
			)
			.bind(destinationUserId, claimedAt, claimedAt, claimedAt, claim.legacyUserId),
		database
			.prepare(
				"INSERT INTO durable_object_cleanup_jobs " +
					"(object_name, owner_user_id, reason, requested_at, completed_at) " +
					"VALUES (?, ?, 'legacy_claimed', ?, NULL) " +
					"ON CONFLICT(object_name) DO UPDATE SET owner_user_id = excluded.owner_user_id, " +
					"reason = excluded.reason, requested_at = excluded.requested_at, completed_at = NULL",
			)
			.bind(claim.legacyUserId, destinationUserId, claimedAt),
		database
			.prepare(
				"DELETE FROM user WHERE id = ? AND NOT EXISTS (SELECT 1 FROM account WHERE account.user_id = user.id)",
			)
			.bind(claim.legacyUserId),
	]);
}

async function cancelPendingClaim(database: D1Database, tokenHash: string, destinationUserId: string): Promise<void> {
	await database
		.prepare("DELETE FROM legacy_identity_claims " + "WHERE token_hash = ? AND user_id = ? AND status = 'pending'")
		.bind(tokenHash, destinationUserId)
		.run();
}

export async function claimLegacyIdentity(
	database: D1Database,
	namespace: DurableObjectNamespace<UserDurableObject>,
	destinationUserId: string,
	legacyToken: string,
): Promise<LegacyIdentityClaimResult> {
	const tokenHash = await hashToken(legacyToken);
	const claim =
		(await findClaim(database, tokenHash)) ?? (await reserveClaim(database, tokenHash, destinationUserId));
	if (claim === null) {
		return {status: "not_found"};
	}
	if (claim.userId !== destinationUserId) {
		return {status: "conflict", message: "legacy identity has already been claimed by another account"};
	}
	if (claim.legacyUserId === destinationUserId) {
		return {status: "conflict", message: "legacy identity already belongs to this account"};
	}

	const source = namespace.getByName(claim.legacyUserId);
	if (claim.status === "complete") {
		await source.clearClaimedLegacyIdentity(destinationUserId);
		await completeDurableObjectCleanup(database, claim.legacyUserId, Date.now());
		return {status: "claimed", alreadyClaimed: true};
	}

	const prepared = await source.prepareLegacyIdentityClaim(destinationUserId);
	if (prepared.status === "conflict") {
		await cancelPendingClaim(database, tokenHash, destinationUserId);
		return {status: "conflict", message: prepared.reason};
	}
	const destination = namespace.getByName(destinationUserId);
	const merged = await destination.mergeLegacyIdentity(claim.legacyUserId, prepared.snapshot);
	if (merged.status === "conflict") {
		await source.releaseLegacyIdentityClaim(destinationUserId);
		await cancelPendingClaim(database, tokenHash, destinationUserId);
		return {status: "conflict", message: merged.reason};
	}
	await completeD1Claim(database, claim, destinationUserId);
	await destination.synchronizePairingState(await getPairedMachineCount(database, destinationUserId));
	await source.clearClaimedLegacyIdentity(destinationUserId);
	await completeDurableObjectCleanup(database, claim.legacyUserId, Date.now());
	return {status: "claimed", alreadyClaimed: false};
}
