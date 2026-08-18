import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import {PAIRING_CODE_TTL_MILLISECONDS} from "../validation";
import {API_ORIGIN, createBatchOverHttp, createVerifiedBrowserSession, registerMachineToken, worker} from "./helpers";

async function requestPairingCode(cookie: string): Promise<{code: string; expires_at: number}> {
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

		const machineToken = await registerMachineToken("alice-machine-owner");
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
			body: {machine_count: 0, paired: false},
			status: 200,
		});

		const issued = await requestPairingCode(session.cookie);
		expect((await claimPairingCode(issued.code, "Alice's laptop")).status).toBe(201);

		const after = await worker.fetch(`${API_ORIGIN}/api/v1/pair/status`, {
			headers: {Cookie: session.cookie},
		});
		expect({body: await after.json(), status: after.status}).toStrictEqual({
			body: {machine_count: 1, paired: true},
			status: 200,
		});
	});
});

describe("POST /api/v1/pair/claim", () => {
	it("exchanges a code for a revocable machine token bound to the account", async () => {
		const session = await createVerifiedBrowserSession();
		const issued = await requestPairingCode(session.cookie);

		const claimed = await claimPairingCode(issued.code, "Alice's laptop");
		expect(claimed.status).toBe(201);
		const machine = await claimed.json<{token: string; credential_type: string}>();
		expect(machine.credential_type).toBe("machine");
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
		const listed = await worker.fetch(`${API_ORIGIN}/api/v1/questions`, {
			headers: {Cookie: session.cookie},
		});
		const body = await listed.json<{questions: Array<{batch_id: string}>}>();
		expect(body.questions.map((question) => question.batch_id)).toStrictEqual([created.batch_id]);
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
		const revoked = await worker.fetch(`${API_ORIGIN}/api/v1/questions`, {
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
