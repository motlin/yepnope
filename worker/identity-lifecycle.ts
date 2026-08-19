import {and, eq, isNull, lte} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {durableObjectCleanupJobs, identityLifecycles, machineTokens, pairingCodes} from "./db/d1-schema";
import type {UserDurableObject} from "./user-do";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

export const REVOKED_TOKEN_RETENTION_MILLISECONDS = 30 * DAY_MILLISECONDS;
export const UNCLAIMED_LEGACY_IDENTITY_RETENTION_MILLISECONDS = 30 * DAY_MILLISECONDS;

type CleanupReason = "account_deleted" | "legacy_claimed" | "legacy_expired";

export interface IdentityCleanupResult {
	expiredLegacyIdentities: number;
	inactiveOAuthAccessTokens: number;
	inactiveOAuthRefreshTokens: number;
	expiredPairingCodes: number;
	revokedTokens: number;
}

interface PendingCleanupJob {
	objectName: string;
	reason: CleanupReason;
}

export async function recordAccountIdentity(database: D1Database, userId: string, createdAt: number): Promise<void> {
	await drizzle(database)
		.insert(identityLifecycles)
		.values({identityId: userId, identityType: "account", ownerUserId: userId, createdAt})
		.onConflictDoNothing();
}

export async function recordLegacyIdentity(
	database: D1Database,
	legacyUserId: string,
	createdAt: number,
): Promise<void> {
	await drizzle(database)
		.insert(identityLifecycles)
		.values({
			identityId: legacyUserId,
			identityType: "legacy",
			ownerUserId: null,
			createdAt,
			expiresAt: createdAt + UNCLAIMED_LEGACY_IDENTITY_RETENTION_MILLISECONDS,
		})
		.onConflictDoNothing();
}

export async function markAccountDeletionRequested(
	database: D1Database,
	userId: string,
	requestedAt: number,
): Promise<void> {
	const connection = drizzle(database);
	await connection
		.update(identityLifecycles)
		.set({deletionRequestedAt: requestedAt})
		.where(and(eq(identityLifecycles.identityId, userId), eq(identityLifecycles.identityType, "account")));
	await requestDurableObjectCleanup(database, userId, userId, "account_deleted", requestedAt);
}

export async function deleteAccountDurableObject(
	database: D1Database,
	namespace: DurableObjectNamespace<UserDurableObject>,
	userId: string,
	deletedAt: number,
): Promise<void> {
	await namespace.getByName(userId).deleteAll();
	const connection = drizzle(database);
	await connection
		.update(identityLifecycles)
		.set({deletedAt})
		.where(and(eq(identityLifecycles.identityId, userId), eq(identityLifecycles.identityType, "account")));
	await connection
		.update(durableObjectCleanupJobs)
		.set({completedAt: deletedAt})
		.where(eq(durableObjectCleanupJobs.objectName, userId));
}

export async function completeDurableObjectCleanup(
	database: D1Database,
	objectName: string,
	completedAt: number,
): Promise<void> {
	await drizzle(database)
		.update(durableObjectCleanupJobs)
		.set({completedAt})
		.where(eq(durableObjectCleanupJobs.objectName, objectName));
}

export async function cleanupExpiredIdentityRecords(
	database: D1Database,
	namespace: DurableObjectNamespace<UserDurableObject>,
	now: number,
): Promise<IdentityCleanupResult> {
	const connection = drizzle(database);
	const expiredLegacyIdentities = await connection
		.select({identityId: identityLifecycles.identityId})
		.from(identityLifecycles)
		.where(
			and(
				eq(identityLifecycles.identityType, "legacy"),
				isNull(identityLifecycles.ownerUserId),
				isNull(identityLifecycles.deletedAt),
				lte(identityLifecycles.expiresAt, now),
			),
		);
	const expiredPairingCodes = await connection.delete(pairingCodes).where(lte(pairingCodes.expiresAt, now));
	const revokedTokens = await connection
		.delete(machineTokens)
		.where(lte(machineTokens.revokedAt, now - REVOKED_TOKEN_RETENTION_MILLISECONDS));
	const [inactiveOAuthAccessTokens, inactiveOAuthRefreshTokens] = await database.batch([
		database
			.prepare("DELETE FROM oauth_access_token WHERE expires_at <= ? OR (revoked IS NOT NULL AND revoked <= ?)")
			.bind(now - REVOKED_TOKEN_RETENTION_MILLISECONDS, now - REVOKED_TOKEN_RETENTION_MILLISECONDS),
		database
			.prepare("DELETE FROM oauth_refresh_token WHERE expires_at <= ? OR (revoked IS NOT NULL AND revoked <= ?)")
			.bind(now - REVOKED_TOKEN_RETENTION_MILLISECONDS, now - REVOKED_TOKEN_RETENTION_MILLISECONDS),
	]);
	if (inactiveOAuthAccessTokens === undefined || inactiveOAuthRefreshTokens === undefined) {
		throw new Error("OAuth credential cleanup batch returned an incomplete result");
	}

	for (const {identityId} of expiredLegacyIdentities) {
		await requestDurableObjectCleanup(database, identityId, null, "legacy_expired", now);
		await database.batch([
			database
				.prepare(
					"UPDATE identity_lifecycles SET deletion_requested_at = ?, deleted_at = ? " +
						"WHERE identity_id = ? AND owner_user_id IS NULL AND deleted_at IS NULL",
				)
				.bind(now, now, identityId),
			database
				.prepare("DELETE FROM user WHERE id = ? AND NOT EXISTS (SELECT 1 FROM account WHERE user_id = ?)")
				.bind(identityId, identityId),
		]);
	}
	await processPendingDurableObjectCleanups(database, namespace, now);

	return {
		expiredLegacyIdentities: expiredLegacyIdentities.length,
		inactiveOAuthAccessTokens: inactiveOAuthAccessTokens.meta.changes,
		inactiveOAuthRefreshTokens: inactiveOAuthRefreshTokens.meta.changes,
		expiredPairingCodes: expiredPairingCodes.meta.changes,
		revokedTokens: revokedTokens.meta.changes,
	};
}

async function processPendingDurableObjectCleanups(
	database: D1Database,
	namespace: DurableObjectNamespace<UserDurableObject>,
	completedAt: number,
): Promise<number> {
	const pending = await drizzle(database)
		.select({objectName: durableObjectCleanupJobs.objectName, reason: durableObjectCleanupJobs.reason})
		.from(durableObjectCleanupJobs)
		.where(isNull(durableObjectCleanupJobs.completedAt));
	let completed = 0;
	for (const job of pending satisfies PendingCleanupJob[]) {
		if (job.reason === "account_deleted") {
			const liveOwner = await database.prepare("SELECT id FROM user WHERE id = ?").bind(job.objectName).first();
			if (liveOwner !== null) {
				continue;
			}
		}
		await namespace.getByName(job.objectName).deleteAll();
		await database.batch([
			database
				.prepare("UPDATE durable_object_cleanup_jobs SET completed_at = ? WHERE object_name = ?")
				.bind(completedAt, job.objectName),
			database
				.prepare("UPDATE identity_lifecycles SET deleted_at = coalesce(deleted_at, ?) WHERE identity_id = ?")
				.bind(completedAt, job.objectName),
		]);
		completed += 1;
	}
	return completed;
}

async function requestDurableObjectCleanup(
	database: D1Database,
	objectName: string,
	ownerUserId: string | null,
	reason: CleanupReason,
	requestedAt: number,
): Promise<void> {
	await drizzle(database)
		.insert(durableObjectCleanupJobs)
		.values({objectName, ownerUserId, reason, requestedAt})
		.onConflictDoUpdate({
			target: durableObjectCleanupJobs.objectName,
			set: {ownerUserId, reason, requestedAt, completedAt: null},
		});
}
