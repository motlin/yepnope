import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe, expect, it} from "vitest";
import {cleanupExpiredIdentityRecords, REVOKED_TOKEN_RETENTION_MILLISECONDS} from "../identity-lifecycle";
import type {UserDurableObject} from "../user-do";
import {API_ORIGIN, createVerifiedBrowserSession, worker} from "./helpers";
import {authorizeDeviceClient} from "./oauth-client-helpers";

const ACCOUNT_PASSWORD = "correct-horse-battery-staple";

describe("identity lifecycle", () => {
	it("records one stable non-empty Durable Object baseline migration", async () => {
		const object = env.USER_DO.getByName("migration-ledger-account");
		expect(await object.getAfk(false)).toBe(false);
		const before = await runInDurableObject(object, (_instance: UserDurableObject, state) =>
			state.storage.sql
				.exec<{migrations: number; nonEmptyHashes: number}>(
					"SELECT count(*) AS migrations, count(*) FILTER (WHERE length(hash) > 0) AS nonEmptyHashes " +
						"FROM __drizzle_migrations",
				)
				.one(),
		);

		expect(await object.getAfk(false)).toBe(false);
		const after = await runInDurableObject(object, (_instance: UserDurableObject, state) =>
			state.storage.sql
				.exec<{migrations: number; nonEmptyHashes: number}>(
					"SELECT count(*) AS migrations, count(*) FILTER (WHERE length(hash) > 0) AS nonEmptyHashes " +
						"FROM __drizzle_migrations",
				)
				.one(),
		);

		expect({after, before}).toStrictEqual({
			after: {migrations: 1, nonEmptyHashes: 1},
			before: {migrations: 1, nonEmptyHashes: 1},
		});
	});

	it("records account ownership and no agent credential during onboarding", async () => {
		const session = await createVerifiedBrowserSession("alice@example.com");

		expect(
			await env.DB.prepare(
				"SELECT identity_id, identity_type, owner_user_id, expires_at, claimed_at, " +
					"deletion_requested_at, deleted_at FROM identity_lifecycles",
			).first(),
		).toStrictEqual({
			claimed_at: null,
			deleted_at: null,
			deletion_requested_at: null,
			expires_at: null,
			identity_id: session.userId,
			identity_type: "account",
			owner_user_id: session.userId,
		});
		expect(await env.DB.prepare("SELECT count(*) AS value FROM oauth_client").first()).toStrictEqual({value: 0});
	});

	it("makes repeated unsigned initialization read-only under concurrency", async () => {
		const before = await env.DB.prepare(
			"SELECT (SELECT count(*) FROM user) AS users, " +
				"(SELECT count(*) FROM device_code) AS device_codes, " +
				"(SELECT count(*) FROM identity_lifecycles) AS identities",
		).first();
		const responses = await Promise.all(
			Array.from({length: 20}, async () =>
				Promise.all([
					worker.fetch(`${API_ORIGIN}/api/auth/get-session`),
					worker.fetch(`${API_ORIGIN}/api/v1/device-authorization?decision=approved`, {
						method: "POST",
						body: JSON.stringify({user_code: "ABC23456"}),
					}),
				]),
			),
		);

		expect(
			responses.map(([session, approval]) => ({approval: approval.status, session: session.status})),
		).toStrictEqual(Array.from({length: 20}, () => ({approval: 401, session: 200})));
		const after = await env.DB.prepare(
			"SELECT (SELECT count(*) FROM user) AS users, " +
				"(SELECT count(*) FROM device_code) AS device_codes, " +
				"(SELECT count(*) FROM identity_lifecycles) AS identities",
		).first();
		expect({after, before}).toStrictEqual({after: before, before});
	});

	it("deletes account storage through the internal cleanup RPC and retains its tombstone", async () => {
		const session = await createVerifiedBrowserSession("account-deletion@example.com");
		const object = env.USER_DO.getByName(session.userId);
		await object.createBatch({project: "example-project", questions: [{title: "Keep this?", body: "No."}]});

		const response = await worker.fetch(`${API_ORIGIN}/api/auth/delete-user`, {
			method: "POST",
			headers: {Cookie: session.cookie, "Content-Type": "application/json", Origin: API_ORIGIN},
			body: JSON.stringify({password: ACCOUNT_PASSWORD}),
		});

		expect({body: await response.json(), status: response.status}).toStrictEqual({
			body: {message: "User deleted", success: true},
			status: 200,
		});
		expect(await env.DB.prepare("SELECT id FROM user WHERE id = ?").bind(session.userId).first()).toBeNull();
		expect(
			await env.DB.prepare(
				"SELECT identity_type, owner_user_id, deletion_requested_at IS NOT NULL AS requested, " +
					"deleted_at IS NOT NULL AS deleted FROM identity_lifecycles WHERE identity_id = ?",
			)
				.bind(session.userId)
				.first(),
		).toStrictEqual({deleted: 1, identity_type: "account", owner_user_id: session.userId, requested: 1});
		expect(
			await env.DB.prepare(
				"SELECT object_name, owner_user_id, reason, requested_at IS NOT NULL AS requested, " +
					"completed_at IS NOT NULL AS completed FROM durable_object_cleanup_jobs WHERE object_name = ?",
			)
				.bind(session.userId)
				.first(),
		).toStrictEqual({
			completed: 1,
			object_name: session.userId,
			owner_user_id: session.userId,
			reason: "account_deleted",
			requested: 1,
		});
		await runInDurableObject(object, async (_instance: UserDurableObject, state) => {
			expect({
				alarm: await state.storage.getAlarm(),
				tables: state.storage.sql
					.exec<{name: string}>(
						"SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN " +
							"('state', 'devices', 'batches', 'questions', 'answers') ORDER BY name",
					)
					.toArray(),
			}).toStrictEqual({alarm: null, tables: []});
		});
	});

	it("expires spent device codes and inactive OAuth credentials without deleting accounts", async () => {
		const now = Date.UTC(2000, 0, 1);
		const accountCreatedAt = Date.UTC(1999, 0, 1);
		const longExpired = now - REVOKED_TOKEN_RETENTION_MILLISECONDS - 1;
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO user (id, email, email_verified, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
			).bind("account-bob", "bob@example.com", accountCreatedAt, accountCreatedAt),
			env.DB.prepare(
				"INSERT INTO identity_lifecycles " +
					"(identity_id, identity_type, owner_user_id, created_at) VALUES (?, 'account', ?, ?)",
			).bind("account-bob", "account-bob", accountCreatedAt),
		]);
		const authorized = await authorizeDeviceClient("account-bob");
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO durable_object_cleanup_jobs " +
					"(object_name, owner_user_id, reason, requested_at) VALUES (?, ?, 'account_deleted', ?)",
			).bind("account-bob", "account-bob", now),
			env.DB.prepare(
				"INSERT INTO device_code (id, device_code, user_code, user_id, expires_at, status) " +
					"VALUES (?, 'abandoned-device-code', 'ABC23456', ?, ?, 'pending')",
			).bind(crypto.randomUUID(), "account-bob", now),
			env.DB.prepare("UPDATE oauth_refresh_token SET revoked = ? WHERE user_id = ?").bind(
				longExpired,
				"account-bob",
			),
		]);

		expect(await cleanupExpiredIdentityRecords(env.DB, env.USER_DO, now)).toStrictEqual({
			abandonedOAuthClients: 0,
			// The redeemed code was consumed by the exchange itself; only the abandoned one is swept.
			expiredDeviceCodes: 1,
			// 🎟️ A device grant's access token is a signed JWT with no row of its own, which is why
			// revocation has to be enforced against the refresh token behind it on every call.
			inactiveOAuthAccessTokens: 0,
			inactiveOAuthRefreshTokens: 1,
			reclaimedOAuthClientResources: 0,
		});
		expect(await env.DB.prepare("SELECT id FROM user WHERE id = 'account-bob'").first()).toStrictEqual({
			id: "account-bob",
		});
		expect(await env.DB.prepare("SELECT count(*) AS value FROM device_code").first()).toStrictEqual({value: 0});
		// 🧹 A revoked grant's consent outlives its tokens, which is what keeps its client off the
		// abandoned-registration sweep until the account itself is gone.
		expect(
			await env.DB.prepare("SELECT count(*) AS value FROM oauth_consent WHERE client_id = ?")
				.bind(authorized.clientId)
				.first(),
		).toStrictEqual({value: 1});
		expect(
			await env.DB.prepare(
				"SELECT completed_at FROM durable_object_cleanup_jobs WHERE object_name = 'account-bob'",
			).first(),
		).toStrictEqual({completed_at: null});
		expect(await cleanupExpiredIdentityRecords(env.DB, env.USER_DO, now)).toStrictEqual({
			abandonedOAuthClients: 0,
			expiredDeviceCodes: 0,
			inactiveOAuthAccessTokens: 0,
			inactiveOAuthRefreshTokens: 0,
			reclaimedOAuthClientResources: 0,
		});
	});
});
