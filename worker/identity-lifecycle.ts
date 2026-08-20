import {and, eq, isNull, lte} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {deviceCodes, durableObjectCleanupJobs, identityLifecycles} from "./db/d1-schema";
import {
	ABANDONED_OAUTH_CLIENT_COUNT_SQL,
	ABANDONED_OAUTH_CLIENT_DELETE_SQL,
	ABANDONED_OAUTH_CLIENT_RESOURCE_DELETE_SQL,
	abandonedOAuthClientBindings,
	ORPHANED_OAUTH_CLIENT_RESOURCE_DELETE_SQL,
	RECLAIMABLE_OAUTH_CLIENT_RESOURCE_COUNT_SQL,
} from "./db/oauth-client-reclamation";
import type {UserDurableObject} from "./user-do";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

export const REVOKED_TOKEN_RETENTION_MILLISECONDS = 30 * DAY_MILLISECONDS;

type CleanupReason = "account_deleted";

export interface OAuthClientReclamationResult {
	abandonedOAuthClients: number;
	reclaimedOAuthClientResources: number;
}

export interface IdentityCleanupResult extends OAuthClientReclamationResult {
	expiredDeviceCodes: number;
	inactiveOAuthAccessTokens: number;
	inactiveOAuthRefreshTokens: number;
}

export async function recordAccountIdentity(database: D1Database, userId: string, createdAt: number): Promise<void> {
	await drizzle(database)
		.insert(identityLifecycles)
		.values({identityId: userId, identityType: "account", ownerUserId: userId, createdAt})
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

async function countedRows(database: D1Database, sql: string, bindings: readonly number[]): Promise<number> {
	const row = await database
		.prepare(sql)
		.bind(...bindings)
		.first<{value: number}>();
	if (row === null) {
		throw new Error("a counting query returned no row");
	}
	return row.value;
}

/**
 * What `reclaimAbandonedOAuthClients` would take, without taking it. The counts come from the same
 * predicate the deletion uses, so a dry run and the run that follows differ only in what the
 * database did in between.
 */
export async function planAbandonedOAuthClientReclamation(
	database: D1Database,
	now: number,
): Promise<OAuthClientReclamationResult> {
	const bindings = abandonedOAuthClientBindings(now);
	return {
		abandonedOAuthClients: await countedRows(database, ABANDONED_OAUTH_CLIENT_COUNT_SQL, bindings),
		reclaimedOAuthClientResources: await countedRows(
			database,
			RECLAIMABLE_OAUTH_CLIENT_RESOURCE_COUNT_SQL,
			bindings,
		),
	};
}

/**
 * 🧹 Reclaims registered OAuth clients that never became grants.
 *
 * All three statements run in one D1 batch, which is one transaction, so the predicate that spares a
 * client also spares its dependent rows, and a client that gains a consent or a token concurrently
 * is protected by the whole batch rather than by whichever statement happened to run first. Running
 * it twice, or twice at once, reclaims nothing the first pass already took.
 */
export async function reclaimAbandonedOAuthClients(
	database: D1Database,
	now: number,
): Promise<OAuthClientReclamationResult> {
	const bindings = abandonedOAuthClientBindings(now);
	const [dependents, clients, orphans] = await database.batch([
		database.prepare(ABANDONED_OAUTH_CLIENT_RESOURCE_DELETE_SQL).bind(...bindings),
		database.prepare(ABANDONED_OAUTH_CLIENT_DELETE_SQL).bind(...bindings),
		database.prepare(ORPHANED_OAUTH_CLIENT_RESOURCE_DELETE_SQL),
	]);
	if (dependents === undefined || clients === undefined || orphans === undefined) {
		throw new Error("OAuth client reclamation batch returned an incomplete result");
	}
	return {
		abandonedOAuthClients: clients.meta.changes,
		reclaimedOAuthClientResources: dependents.meta.changes + orphans.meta.changes,
	};
}

export async function cleanupExpiredIdentityRecords(
	database: D1Database,
	namespace: DurableObjectNamespace<UserDurableObject>,
	now: number,
): Promise<IdentityCleanupResult> {
	const connection = drizzle(database);
	// 📟 A device code is a ten-minute artefact whether it was approved, denied, or ignored. The
	// grant it produced lives in the OAuth tables; the code itself has nothing left to say.
	const expiredDeviceCodes = await connection.delete(deviceCodes).where(lte(deviceCodes.expiresAt, new Date(now)));
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

	await processPendingDurableObjectCleanups(database, namespace, now);
	// 🧹 Last, so a client whose final token was purged above still keeps its consent, and a consent
	// is enough to spare it.
	const reclaimedOAuthClients = await reclaimAbandonedOAuthClients(database, now);

	return {
		...reclaimedOAuthClients,
		expiredDeviceCodes: expiredDeviceCodes.meta.changes,
		inactiveOAuthAccessTokens: inactiveOAuthAccessTokens.meta.changes,
		inactiveOAuthRefreshTokens: inactiveOAuthRefreshTokens.meta.changes,
	};
}

async function processPendingDurableObjectCleanups(
	database: D1Database,
	namespace: DurableObjectNamespace<UserDurableObject>,
	completedAt: number,
): Promise<number> {
	const pending = await drizzle(database)
		.select({objectName: durableObjectCleanupJobs.objectName})
		.from(durableObjectCleanupJobs)
		.where(isNull(durableObjectCleanupJobs.completedAt));
	let completed = 0;
	for (const job of pending) {
		// A deletion that the account cancelled by still existing is not a deletion.
		const liveOwner = await database.prepare("SELECT id FROM user WHERE id = ?").bind(job.objectName).first();
		if (liveOwner !== null) {
			continue;
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
