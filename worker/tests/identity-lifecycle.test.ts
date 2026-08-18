import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe, expect, it} from "vitest";
import {hashToken} from "../auth";
import {
	cleanupExpiredIdentityRecords,
	recordLegacyIdentity,
	REVOKED_TOKEN_RETENTION_MILLISECONDS,
	UNCLAIMED_LEGACY_IDENTITY_RETENTION_MILLISECONDS,
} from "../identity-lifecycle";
import type {UserDurableObject} from "../user-do";
import {API_ORIGIN, createVerifiedBrowserSession, worker} from "./helpers";

const ACCOUNT_PASSWORD = "correct-horse-battery-staple";

describe("identity lifecycle", () => {
	it("records account ownership and creates no machine credential during onboarding", async () => {
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
		expect(await env.DB.prepare("SELECT count(*) AS value FROM machine_tokens").first()).toStrictEqual({value: 0});
	});

	it("makes repeated unsigned initialization read-only under concurrency", async () => {
		const before = await env.DB.prepare(
			"SELECT (SELECT count(*) FROM user) AS users, " +
				"(SELECT count(*) FROM machine_tokens) AS tokens, " +
				"(SELECT count(*) FROM identity_lifecycles) AS identities",
		).first();
		const responses = await Promise.all(
			Array.from({length: 20}, async () =>
				Promise.all([
					worker.fetch(`${API_ORIGIN}/api/auth/get-session`),
					worker.fetch(`${API_ORIGIN}/api/v1/pair/new`, {method: "POST"}),
				]),
			),
		);

		expect(
			responses.map(([session, pairing]) => ({pairing: pairing.status, session: session.status})),
		).toStrictEqual(Array.from({length: 20}, () => ({pairing: 401, session: 200})));
		const after = await env.DB.prepare(
			"SELECT (SELECT count(*) FROM user) AS users, " +
				"(SELECT count(*) FROM machine_tokens) AS tokens, " +
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

	it("expires abandoned legacy identities, pairing codes, and revoked credentials without deleting accounts", async () => {
		const now = Date.UTC(2000, 0, 1);
		const legacyCreatedAt = now - UNCLAIMED_LEGACY_IDENTITY_RETENTION_MILLISECONDS - 1;
		const accountCreatedAt = Date.UTC(1999, 0, 1);
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
			).bind("legacy-alice", "Legacy Alice", "legacy-alice@example.com", legacyCreatedAt, legacyCreatedAt),
			env.DB.prepare(
				"INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
			).bind("account-bob", "Bob", "bob@example.com", accountCreatedAt, accountCreatedAt),
			env.DB.prepare(
				"INSERT INTO identity_lifecycles " +
					"(identity_id, identity_type, owner_user_id, created_at) VALUES (?, 'account', ?, ?)",
			).bind("account-bob", "account-bob", accountCreatedAt),
		]);
		await recordLegacyIdentity(env.DB, "legacy-alice", legacyCreatedAt);
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO durable_object_cleanup_jobs " +
					"(object_name, owner_user_id, reason, requested_at) VALUES (?, ?, 'account_deleted', ?)",
			).bind("account-bob", "account-bob", now),
			env.DB.prepare(
				"INSERT INTO machine_tokens " +
					"(token_hash, user_id, label, credential_type, created_at) VALUES (?, ?, 'app', 'legacy_app', ?)",
			).bind(await hashToken("legacy-alice-browser-token"), "legacy-alice", legacyCreatedAt),
			env.DB.prepare(
				"INSERT INTO machine_tokens " +
					"(token_hash, user_id, label, credential_type, created_at, revoked_at) " +
					"VALUES (?, ?, 'old machine', 'machine', ?, ?)",
			).bind(
				await hashToken("bob-old-revoked-machine-token"),
				"account-bob",
				accountCreatedAt,
				now - REVOKED_TOKEN_RETENTION_MILLISECONDS,
			),
			env.DB.prepare(
				"INSERT INTO pairing_codes (code, user_id, created_at, expires_at) VALUES ('ABC234', ?, ?, ?)",
			).bind("account-bob", accountCreatedAt, now),
		]);
		await env.USER_DO.getByName("legacy-alice").setAfk(true);

		expect(await cleanupExpiredIdentityRecords(env.DB, env.USER_DO, now)).toStrictEqual({
			expiredLegacyIdentities: 1,
			expiredPairingCodes: 1,
			revokedTokens: 1,
		});
		expect(
			(await env.DB.prepare("SELECT id FROM user WHERE id IN ('account-bob', 'legacy-alice') ORDER BY id").all())
				.results,
		).toStrictEqual([{id: "account-bob"}]);
		expect(await env.DB.prepare("SELECT count(*) AS value FROM machine_tokens").first()).toStrictEqual({value: 0});
		expect(await env.DB.prepare("SELECT count(*) AS value FROM pairing_codes").first()).toStrictEqual({value: 0});
		expect(
			(
				await env.DB.prepare(
					"SELECT identity_id, identity_type, owner_user_id, deleted_at IS NOT NULL AS deleted " +
						"FROM identity_lifecycles WHERE identity_id IN ('account-bob', 'legacy-alice') " +
						"ORDER BY identity_id",
				).all()
			).results,
		).toStrictEqual([
			{deleted: 0, identity_id: "account-bob", identity_type: "account", owner_user_id: "account-bob"},
			{deleted: 1, identity_id: "legacy-alice", identity_type: "legacy", owner_user_id: null},
		]);
		expect(
			await env.DB.prepare(
				"SELECT object_name, reason, completed_at IS NOT NULL AS completed " +
					"FROM durable_object_cleanup_jobs WHERE object_name = 'legacy-alice'",
			).first(),
		).toStrictEqual({completed: 1, object_name: "legacy-alice", reason: "legacy_expired"});
		expect(
			await env.DB.prepare(
				"SELECT completed_at FROM durable_object_cleanup_jobs WHERE object_name = 'account-bob'",
			).first(),
		).toStrictEqual({completed_at: null});
		expect(await cleanupExpiredIdentityRecords(env.DB, env.USER_DO, now)).toStrictEqual({
			expiredLegacyIdentities: 0,
			expiredPairingCodes: 0,
			revokedTokens: 0,
		});
	});
});
