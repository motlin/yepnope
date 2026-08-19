import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe, expect, it} from "vitest";
import {hashToken} from "../auth";
import type {UserDurableObject} from "../user-do";
import {API_ORIGIN, createVerifiedBrowserSession, nextMessage, required, worker} from "./helpers";

async function seedLegacyIdentity(legacyUserId: string, legacyToken: string, pairingCode: string): Promise<string> {
	const now = Date.now();
	await env.DB.prepare("INSERT INTO user (id, email, email_verified, created_at, updated_at) VALUES (?, ?, 0, ?, ?)")
		.bind(legacyUserId, `${legacyUserId}@example.com`, now, now)
		.run();
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO machine_tokens " +
				"(token_hash, user_id, label, credential_type, created_at) VALUES (?, ?, 'app', 'legacy_app', ?)",
		).bind(await hashToken(legacyToken), legacyUserId, now),
		env.DB.prepare(
			"INSERT INTO machine_tokens " +
				"(token_hash, user_id, label, credential_type, created_at) VALUES (?, ?, 'Alice machine', 'machine', ?)",
		).bind(await hashToken(`machine-${legacyUserId}`), legacyUserId, now),
		env.DB.prepare("INSERT INTO pairing_codes (code, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(
			pairingCode,
			legacyUserId,
			now,
			now + 60_000,
		),
	]);
	return `machine-${legacyUserId}`;
}

async function claimLegacy(cookie: string, legacyToken: string): Promise<Response> {
	return worker.fetch(`${API_ORIGIN}/api/v1/account/claim-legacy`, {
		method: "POST",
		headers: {Cookie: cookie, "Content-Type": "application/json"},
		body: JSON.stringify({legacy_token: legacyToken}),
	});
}

describe("POST /api/v1/account/claim-legacy", () => {
	it("requires a verified Better Auth session and a legacy app credential", async () => {
		const response = await claimLegacy("", "legacy-app-token-that-is-long-enough");
		expect(response.status).toBe(401);

		const session = await createVerifiedBrowserSession();
		const missing = await claimLegacy(session.cookie, "unknown-legacy-token-that-is-long-enough");
		expect(missing.status).toBe(404);
	});

	it("moves legacy storage and credentials once, then makes retries idempotent", async () => {
		const session = await createVerifiedBrowserSession();
		const legacyUserId = "legacy-alice";
		const legacyToken = "legacy-app-token-for-alice-that-is-long-enough";
		const legacyMachineToken = await seedLegacyIdentity(legacyUserId, legacyToken, "ABC234");
		const source = env.USER_DO.getByName(legacyUserId);
		await source.setAfk(true, true);
		const sourceBatch = await source.createBatch({
			project: "legacy-project",
			questions: [
				{title: "Keep the old data?", body: "Move this answered question."},
				{title: "Keep the open card?", body: "Move this unanswered question."},
			],
		});
		await source.submitAnswers([{question_id: sourceBatch.questionIds[0]!, disposition: "yep"}]);
		await source.registerDevice(
			{
				endpoint: "https://push.example.com/legacy-device",
				keys: {p256dh: "legacy-public-key", auth: "legacy-auth-secret"},
			},
			"Alice's browser",
		);

		const destination = env.USER_DO.getByName(session.userId);
		const destinationBatch = await destination.createBatch({
			project: "account-project",
			questions: [{title: "Keep account data?", body: "Preserve this existing card too."}],
		});
		await destination.submitAnswers([{question_id: destinationBatch.questionIds[0]!, disposition: "nope"}]);

		const claimed = await claimLegacy(session.cookie, legacyToken);
		expect({body: await claimed.json(), status: claimed.status}).toStrictEqual({
			body: {already_claimed: false, status: "claimed"},
			status: 200,
		});

		const machineRows = await env.DB.prepare(
			"SELECT label, credential_type, revoked_at IS NOT NULL AS revoked, user_id " +
				"FROM machine_tokens ORDER BY label",
		).all();
		expect(machineRows.results).toStrictEqual([
			{credential_type: "machine", label: "Alice machine", revoked: 0, user_id: session.userId},
			{credential_type: "legacy_app", label: "app", revoked: 1, user_id: session.userId},
		]);
		const pairingRows = await env.DB.prepare("SELECT code, user_id FROM pairing_codes").all();
		expect(pairingRows.results).toStrictEqual([{code: "ABC234", user_id: session.userId}]);
		const claimRows = await env.DB.prepare(
			"SELECT legacy_user_id, user_id, status, claimed_at IS NOT NULL AS claimed " +
				"FROM legacy_identity_claims",
		).all();
		expect(claimRows.results).toStrictEqual([
			{claimed: 1, legacy_user_id: legacyUserId, status: "complete", user_id: session.userId},
		]);
		expect(await env.DB.prepare("SELECT id FROM user WHERE id = ?").bind(legacyUserId).first()).toBeNull();

		await runInDurableObject(destination, (_instance: UserDurableObject, state) => {
			expect({
				answers: state.storage.sql.exec("SELECT count(*) AS value FROM answers").one()["value"],
				batches: state.storage.sql.exec("SELECT count(*) AS value FROM batches").one()["value"],
				devices: state.storage.sql.exec("SELECT count(*) AS value FROM devices").one()["value"],
				activity: state.storage.sql.exec("SELECT count(*) AS value FROM question_activity").one()["value"],
				questions: state.storage.sql.exec("SELECT count(*) AS value FROM questions").one()["value"],
				state: state.storage.sql.exec("SELECT afk FROM state").one(),
			}).toStrictEqual({
				answers: 2,
				batches: 2,
				devices: 1,
				activity: 3,
				questions: 3,
				state: {afk: 0},
			});
		});
		await runInDurableObject(source, async (_instance: UserDurableObject, state) => {
			expect({
				alarm: await state.storage.getAlarm(),
				tables: state.storage.sql
					.exec<{name: string}>(
						"SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN " +
							"('state', 'devices', 'batches', 'questions', 'answers') ORDER BY name",
					)
					.toArray(),
			}).toStrictEqual({
				alarm: null,
				tables: [],
			});
		});
		expect(
			await env.DB.prepare(
				"SELECT identity_id, identity_type, owner_user_id, claimed_at IS NOT NULL AS claimed, " +
					"deleted_at IS NOT NULL AS deleted FROM identity_lifecycles WHERE identity_id = ?",
			)
				.bind(legacyUserId)
				.first(),
		).toStrictEqual({
			claimed: 1,
			deleted: 1,
			identity_id: legacyUserId,
			identity_type: "legacy",
			owner_user_id: session.userId,
		});
		expect(
			await env.DB.prepare(
				"SELECT object_name, reason, completed_at IS NOT NULL AS completed " +
					"FROM durable_object_cleanup_jobs WHERE object_name = ?",
			)
				.bind(legacyUserId)
				.first(),
		).toStrictEqual({completed: 1, object_name: legacyUserId, reason: "legacy_claimed"});

		const retried = await claimLegacy(session.cookie, legacyToken);
		expect({body: await retried.json(), status: retried.status}).toStrictEqual({
			body: {already_claimed: true, status: "claimed"},
			status: 200,
		});
		const legacyRejected = await worker.fetch(`${API_ORIGIN}/api/v1/current-deck`, {
			headers: {Authorization: `Bearer ${legacyToken}`},
		});
		expect(legacyRejected.status).toBe(401);
		const movedMachine = await worker.fetch(`${API_ORIGIN}/api/v1/current-deck`, {
			headers: {Authorization: `Bearer ${legacyMachineToken}`},
		});
		const movedMachineBody = await movedMachine.json<{
			current_deck: Array<{created_at: number; [key: string]: unknown}>;
		}>();
		const movedQuestion = movedMachineBody.current_deck[0];
		if (movedQuestion === undefined) {
			throw new Error("moved machine did not receive the legacy question");
		}
		const {created_at: createdAt, ...stableQuestion} = movedQuestion;
		expect(createdAt).toBeTypeOf("number");
		expect({question: stableQuestion, status: movedMachine.status}).toStrictEqual({
			question: {
				batch_id: sourceBatch.batchId,
				body: "Move this unanswered question.",
				branch: null,
				directory: null,
				position: 1,
				project: "legacy-project",
				question_id: sourceBatch.questionIds[1],
				repo: null,
				title: "Keep the open card?",
				worktree: null,
			},
			status: 200,
		});
	});

	it("deduplicates concurrent legacy claims from multiple browser tabs", async () => {
		const session = await createVerifiedBrowserSession("multi-tab-alice@example.com");
		const legacyUserId = "legacy-multi-tab-alice";
		const legacyToken = "legacy-app-token-for-multi-tab-alice";
		await seedLegacyIdentity(legacyUserId, legacyToken, "GHJ678");

		const responses = await Promise.all([
			claimLegacy(session.cookie, legacyToken),
			claimLegacy(session.cookie, legacyToken),
		]);
		const results = await Promise.all(
			responses.map(async (response) => ({
				body: await response.json(),
				status: response.status,
			})),
		);
		expect(
			[...results].sort((left, right) => JSON.stringify(left.body).localeCompare(JSON.stringify(right.body))),
		).toStrictEqual([
			{body: {already_claimed: false, status: "claimed"}, status: 200},
			{body: {already_claimed: false, status: "claimed"}, status: 200},
		]);
		expect(
			await env.DB.prepare(
				"SELECT count(*) AS value FROM legacy_identity_claims WHERE legacy_user_id = ? AND user_id = ?",
			)
				.bind(legacyUserId, session.userId)
				.first(),
		).toStrictEqual({value: 1});
		expect(
			await env.DB.prepare(
				"SELECT count(*) AS value FROM machine_tokens WHERE user_id = ? AND credential_type = 'machine'",
			)
				.bind(session.userId)
				.first(),
		).toStrictEqual({value: 1});
	});

	it("keeps legacy pairing separate from connected MCP client authorization", async () => {
		const session = await createVerifiedBrowserSession();
		const legacyUserId = "legacy-recovered-alice";
		const legacyToken = "legacy-app-token-for-recovered-alice";
		await seedLegacyIdentity(legacyUserId, legacyToken, "JKM789");
		await env.USER_DO.getByName(legacyUserId).setAfk(true, true);
		const streamResponse = await worker.fetch(`${API_ORIGIN}/api/v1/current-deck/stream`, {
			headers: {Cookie: session.cookie, Upgrade: "websocket"},
		});
		const socket = required(streamResponse.webSocket ?? undefined, "question websocket");
		const initialState = nextMessage(socket);
		socket.accept();
		expect(JSON.parse(await initialState)).toStrictEqual({
			type: "current_deck",
			afk: false,
			connected_mcp_client_count: 0,
			current_deck: [],
		});

		expect((await claimLegacy(session.cookie, legacyToken)).status).toBe(200);
		const stateAfterClaim = await worker.fetch(`${API_ORIGIN}/api/v1/current-deck`, {
			headers: {Cookie: session.cookie},
		});
		expect(await stateAfterClaim.json()).toStrictEqual({current_deck: []});
		const devicesAfterClaim = await worker.fetch(`${API_ORIGIN}/api/v1/account/devices`, {
			headers: {Cookie: session.cookie},
		});
		expect(await devicesAfterClaim.json()).toStrictEqual({connected_mcp_clients: [], push_devices: []});
		socket.close();
	});

	it("rejects conflicting Durable Object rows without dropping source data", async () => {
		const session = await createVerifiedBrowserSession();
		const legacyUserId = "legacy-conflict";
		const legacyToken = "legacy-app-token-for-conflict-that-is-long-enough";
		await seedLegacyIdentity(legacyUserId, legacyToken, "DEF567");
		const endpoint = "https://push.example.com/shared-device";
		await env.USER_DO.getByName(legacyUserId).registerDevice(
			{endpoint, keys: {p256dh: "legacy-public-key", auth: "legacy-auth-secret"}},
			"Alice's old browser",
		);
		await env.USER_DO.getByName(session.userId).registerDevice(
			{endpoint, keys: {p256dh: "account-public-key", auth: "account-auth-secret"}},
			"Alice's new browser",
		);

		const response = await claimLegacy(session.cookie, legacyToken);
		expect({body: await response.json(), status: response.status}).toStrictEqual({
			body: {message: expect.stringMatching(/^conflicting Durable Object row:/)},
			status: 409,
		});
		expect(
			await env.DB.prepare("SELECT status, user_id FROM legacy_identity_claims WHERE legacy_user_id = ?")
				.bind(legacyUserId)
				.first(),
		).toBeNull();
		expect(
			await env.DB.prepare(
				"SELECT user_id, revoked_at FROM machine_tokens WHERE credential_type = 'legacy_app' AND user_id = ?",
			)
				.bind(legacyUserId)
				.first(),
		).toStrictEqual({revoked_at: null, user_id: legacyUserId});
		const source = env.USER_DO.getByName(legacyUserId);
		await source.setAfk(false, true);
		await runInDurableObject(source, (_instance: UserDurableObject, state) => {
			expect(state.storage.sql.exec("SELECT count(*) AS value FROM devices").one()).toStrictEqual({value: 1});
		});
	});
});
