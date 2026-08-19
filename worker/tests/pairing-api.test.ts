import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import {hashToken} from "../auth";
import {
	MACHINE_TOKEN_ENCODED_CHARACTERS,
	MACHINE_TOKEN_PATTERN,
	MACHINE_TOKEN_PREFIX,
	MACHINE_TOKEN_RANDOM_BYTES,
} from "../machine-token";
import {PAIRING_CODE_TTL_MILLISECONDS} from "../validation";
import {base64UrlDecode} from "../webcrypto";
import {
	API_ORIGIN,
	createBatchOverHttp,
	createVerifiedBrowserSession,
	registerLegacyMachineWithConnectedMcpClient,
	worker,
} from "./helpers";
import {seedOAuthMcpClient} from "./oauth-client-helpers";

interface PairingStatusBody {
	machine_count: number;
	paired: boolean;
	pending_pairing_expires_at: number | null;
}

interface PairingCodeBody {
	code: string;
	expires_at: number;
	pairing: PairingStatusBody;
}

async function requestPairingCode(cookie: string): Promise<PairingCodeBody> {
	const response = await worker.fetch(`${API_ORIGIN}/api/v1/pair/code`, {
		method: "POST",
		headers: {Cookie: cookie},
	});
	expect(response.status).toBe(201);
	return response.json();
}

async function claimPairingCode(code: string, label: string): Promise<Response> {
	return worker.fetch(`${API_ORIGIN}/api/v1/pair/claim`, {
		method: "POST",
		body: JSON.stringify({code, label}),
	});
}

describe("POST /api/v1/pair/new", () => {
	it("does not create an anonymous server identity", async () => {
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/pair/new`, {method: "POST"});
		expect(response.status).toBe(401);
		expect(
			await env.DB.prepare(
				"SELECT (SELECT count(*) FROM user) AS users, (SELECT count(*) FROM machine_tokens) AS machines",
			).first(),
		).toStrictEqual({machines: 0, users: 0});
	});

	it("accepts only a verified browser session", async () => {
		const session = await createVerifiedBrowserSession();
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/pair/new`, {
			method: "POST",
			headers: {Cookie: session.cookie},
		});
		expect({body: await response.json(), status: response.status}).toStrictEqual({
			body: {status: "ready"},
			status: 200,
		});
	});
});

describe("POST /api/v1/pair/code", () => {
	it("requires a verified browser session", async () => {
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/pair/code`, {method: "POST"});
		expect(response.status).toBe(401);

		const machineToken = await registerLegacyMachineWithConnectedMcpClient("alice-machine-owner");
		const machineResponse = await worker.fetch(`${API_ORIGIN}/api/v1/pair/code`, {
			method: "POST",
			headers: {Authorization: `Bearer ${machineToken}`},
		});
		expect(machineResponse.status).toBe(401);
	});

	it("issues a six-character code owned by the signed-in account", async () => {
		const session = await createVerifiedBrowserSession();
		const before = Date.now();
		const issued = await requestPairingCode(session.cookie);
		expect(issued.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
		expect(issued.expires_at).toBeGreaterThanOrEqual(before + PAIRING_CODE_TTL_MILLISECONDS);
		expect(issued.expires_at).toBeLessThanOrEqual(Date.now() + PAIRING_CODE_TTL_MILLISECONDS);
		expect(issued.pairing).toStrictEqual({
			machine_count: 0,
			paired: false,
			pending_pairing_expires_at: issued.expires_at,
		});
		expect(
			await env.DB.prepare("SELECT user_id FROM pairing_codes WHERE code = ?").bind(issued.code).first(),
		).toStrictEqual({user_id: session.userId});
	});
});

describe("GET /api/v1/pair/status", () => {
	it("requires a verified browser session", async () => {
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/pair/status`);
		expect(response.status).toBe(401);
	});

	it("reports account-owned machine pairing changes", async () => {
		const session = await createVerifiedBrowserSession();
		const before = await worker.fetch(`${API_ORIGIN}/api/v1/pair/status`, {
			headers: {Cookie: session.cookie},
		});
		expect({body: await before.json(), status: before.status}).toStrictEqual({
			body: {machine_count: 0, paired: false, pending_pairing_expires_at: null},
			status: 200,
		});

		const issued = await requestPairingCode(session.cookie);
		const pending = await worker.fetch(`${API_ORIGIN}/api/v1/pair/status`, {
			headers: {Cookie: session.cookie},
		});
		expect({body: await pending.json(), status: pending.status}).toStrictEqual({
			body: {
				machine_count: 0,
				paired: false,
				pending_pairing_expires_at: issued.expires_at,
			},
			status: 200,
		});
		expect((await claimPairingCode(issued.code, "Alice's laptop")).status).toBe(201);

		const after = await worker.fetch(`${API_ORIGIN}/api/v1/pair/status`, {
			headers: {Cookie: session.cookie},
		});
		expect({body: await after.json(), status: after.status}).toStrictEqual({
			body: {machine_count: 1, paired: true, pending_pairing_expires_at: null},
			status: 200,
		});
	});
});

describe("POST /api/v1/pair/claim", () => {
	it("keeps previously hashed unprefixed machine credentials valid", async () => {
		const existingToken = await registerLegacyMachineWithConnectedMcpClient("alice-existing-machine");
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/afk`, {
			headers: {Authorization: `Bearer ${existingToken}`},
		});
		expect({body: await response.json(), status: response.status}).toStrictEqual({
			body: {afk: true},
			status: 200,
		});
	});

	it("exchanges a code for a revocable machine token bound to the account", async () => {
		const session = await createVerifiedBrowserSession();
		const issued = await requestPairingCode(session.cookie);

		const claimStartedAt = Date.now();
		const claimed = await claimPairingCode(issued.code, "Alice's laptop");
		const machine = await claimed.json<{token: string; credential_type: string}>();
		const encodedToken = machine.token.slice(MACHINE_TOKEN_PREFIX.length);
		expect({
			claim: {body: machine.credential_type, status: claimed.status},
			format: {
				decodedBytes: base64UrlDecode(encodedToken).byteLength,
				encodedCharacters: encodedToken.length,
				matchesContract: MACHINE_TOKEN_PATTERN.test(machine.token),
				prefix: machine.token.slice(0, MACHINE_TOKEN_PREFIX.length),
			},
		}).toStrictEqual({
			claim: {body: "machine", status: 201},
			format: {
				decodedBytes: MACHINE_TOKEN_RANDOM_BYTES,
				encodedCharacters: MACHINE_TOKEN_ENCODED_CHARACTERS,
				matchesContract: true,
				prefix: MACHINE_TOKEN_PREFIX,
			},
		});

		const stored = await env.DB.prepare(
			"SELECT token_hash, user_id, label, credential_type, created_at, last_used_at, revoked_at " +
				"FROM machine_tokens WHERE user_id = ?",
		)
			.bind(session.userId)
			.first<{
				token_hash: string;
				user_id: string;
				label: string;
				credential_type: string;
				created_at: number;
				last_used_at: number | null;
				revoked_at: number | null;
			}>();
		const columns = await env.DB.prepare("PRAGMA table_info(machine_tokens)").all<{name: string}>();
		const {created_at: createdAt, ...storedCredential} = stored ?? {created_at: undefined};
		expect(createdAt).toBeGreaterThanOrEqual(claimStartedAt);
		expect(createdAt).toBeLessThanOrEqual(Date.now());
		expect({
			columnNames: columns.results.map(({name}) => name),
			hashMatches: stored?.token_hash === (await hashToken(machine.token)),
			plaintextStored: Object.values(stored ?? {}).includes(machine.token),
			storedCredential,
		}).toStrictEqual({
			columnNames: [
				"id",
				"token_hash",
				"user_id",
				"label",
				"credential_type",
				"created_at",
				"last_used_at",
				"revoked_at",
			],
			hashMatches: true,
			plaintextStored: false,
			storedCredential: {
				credential_type: "machine",
				label: "Alice's laptop",
				last_used_at: null,
				revoked_at: null,
				token_hash: await hashToken(machine.token),
				user_id: session.userId,
			},
		});
		const deniedAfk = await worker.fetch(`${API_ORIGIN}/api/v1/afk`, {
			method: "PUT",
			headers: {Authorization: `Bearer ${machine.token}`},
			body: JSON.stringify({afk: true}),
		});
		expect({body: await deniedAfk.json(), status: deniedAfk.status}).toStrictEqual({
			body: {
				error: "connected_mcp_client_required",
				message: "Authorize an MCP host or OAuth CLI client before turning AFK on.",
			},
			status: 409,
		});
		await seedOAuthMcpClient(session.userId, "pairing-rollout-cli");
		expect(
			(
				await worker.fetch(`${API_ORIGIN}/api/v1/afk`, {
					method: "PUT",
					headers: {Authorization: `Bearer ${machine.token}`},
					body: JSON.stringify({afk: true}),
				})
			).status,
		).toBe(200);

		const created = await createBatchOverHttp(machine.token, "example-project", [
			{title: "Continue?", body: "Proceed with the example operation?"},
		]);
		const listed = await worker.fetch(`${API_ORIGIN}/api/v1/current-deck`, {
			headers: {Cookie: session.cookie},
		});
		const body = await listed.json<{current_deck: Array<{batch_id: string}>}>();
		expect(body.current_deck.map((question) => question.batch_id)).toStrictEqual([created.batch_id]);
		expect(
			await env.DB.prepare(
				"SELECT user_id, label, last_used_at IS NOT NULL AS was_used, revoked_at FROM machine_tokens WHERE user_id = ?",
			)
				.bind(session.userId)
				.first(),
		).toStrictEqual({label: "Alice's laptop", revoked_at: null, user_id: session.userId, was_used: 1});

		await env.DB.prepare("UPDATE machine_tokens SET revoked_at = ? WHERE user_id = ?")
			.bind(Date.now(), session.userId)
			.run();
		const revoked = await worker.fetch(`${API_ORIGIN}/api/v1/current-deck`, {
			headers: {Authorization: `Bearer ${machine.token}`},
		});
		expect(revoked.status).toBe(401);
	});

	it("rejects an unknown code", async () => {
		const response = await claimPairingCode("ZZZZZZ", "Alice's laptop");
		expect(response.status).toBe(404);
	});

	it("rejects a malformed claim", async () => {
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/pair/claim`, {
			method: "POST",
			body: JSON.stringify({label: "Missing code"}),
		});
		expect(response.status).toBe(400);
	});

	it("is single-use", async () => {
		const session = await createVerifiedBrowserSession();
		const issued = await requestPairingCode(session.cookie);
		const responses = await Promise.all([
			claimPairingCode(issued.code, "Alice's first laptop"),
			claimPairingCode(issued.code, "Alice's second laptop"),
		]);
		expect(responses.map((response) => response.status).sort()).toStrictEqual([201, 404]);
		expect(
			await env.DB.prepare(
				"SELECT count(*) AS value FROM machine_tokens WHERE user_id = ? AND credential_type = 'machine'",
			)
				.bind(session.userId)
				.first(),
		).toStrictEqual({value: 1});
	});

	it("rejects an expired code", async () => {
		const session = await createVerifiedBrowserSession();
		const issued = await requestPairingCode(session.cookie);
		await env.DB.prepare("UPDATE pairing_codes SET expires_at = ? WHERE code = ?")
			.bind(Date.now() - 1, issued.code)
			.run();
		expect((await claimPairingCode(issued.code, "Alice's laptop")).status).toBe(404);
	});
});
