import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import {PAIRING_CODE_TTL_MILLISECONDS} from "../validation";
import {API_ORIGIN, createBatchOverHttp, worker} from "./helpers";

async function createAppIdentity(): Promise<string> {
	const response = await worker.fetch(`${API_ORIGIN}/api/v1/pair/new`, {method: "POST"});
	expect(response.status).toBe(201);
	const body = await response.json<{token: string}>();
	return body.token;
}

async function requestPairingCode(appToken: string): Promise<{code: string; expires_at: number}> {
	const response = await worker.fetch(`${API_ORIGIN}/api/v1/pair/code`, {
		method: "POST",
		headers: {Authorization: `Bearer ${appToken}`},
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
	it("mints an app token that authenticates", async () => {
		const appToken = await createAppIdentity();
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/questions`, {
			headers: {Authorization: `Bearer ${appToken}`},
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({questions: []});
	});
});

describe("POST /api/v1/pair/code", () => {
	it("requires authentication", async () => {
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/pair/code`, {method: "POST"});
		expect(response.status).toBe(401);
	});

	it("issues a six-character code with a ten minute expiry", async () => {
		const appToken = await createAppIdentity();
		const before = Date.now();
		const issued = await requestPairingCode(appToken);
		expect(issued.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
		expect(issued.expires_at).toBeGreaterThanOrEqual(before + PAIRING_CODE_TTL_MILLISECONDS);
		expect(issued.expires_at).toBeLessThanOrEqual(Date.now() + PAIRING_CODE_TTL_MILLISECONDS);
	});
});

describe("GET /api/v1/pair/status", () => {
	it("requires authentication", async () => {
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/pair/status`);
		expect(response.status).toBe(401);
	});

	it("reports machine pairing changes", async () => {
		const appToken = await createAppIdentity();
		const before = await worker.fetch(`${API_ORIGIN}/api/v1/pair/status`, {
			headers: {Authorization: `Bearer ${appToken}`},
		});
		expect(before.status).toBe(200);
		expect(await before.json()).toEqual({paired: false, machine_count: 0});

		const issued = await requestPairingCode(appToken);
		expect((await claimPairingCode(issued.code, "craig-mbp")).status).toBe(201);

		const after = await worker.fetch(`${API_ORIGIN}/api/v1/pair/status`, {
			headers: {Authorization: `Bearer ${appToken}`},
		});
		expect(after.status).toBe(200);
		expect(await after.json()).toEqual({paired: true, machine_count: 1});
	});
});

describe("POST /api/v1/pair/claim", () => {
	it("exchanges a code for a machine token bound to the same user", async () => {
		const appToken = await createAppIdentity();
		const issued = await requestPairingCode(appToken);

		const claimed = await claimPairingCode(issued.code, "craig-mbp");
		expect(claimed.status).toBe(201);
		const machine = await claimed.json<{token: string}>();

		const created = await createBatchOverHttp(machine.token, "paired-project", [{title: "Linked?", body: ""}]);
		const listed = await worker.fetch(`${API_ORIGIN}/api/v1/questions`, {
			headers: {Authorization: `Bearer ${appToken}`},
		});
		const body = await listed.json<{questions: Array<{batch_id: string}>}>();
		expect(body.questions.map((question) => question.batch_id)).toEqual([created.batch_id]);
	});

	it("rejects an unknown code", async () => {
		const response = await claimPairingCode("ZZZZZZ", "craig-mbp");
		expect(response.status).toBe(404);
	});

	it("rejects a malformed claim", async () => {
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/pair/claim`, {
			method: "POST",
			body: JSON.stringify({label: "no code"}),
		});
		expect(response.status).toBe(400);
	});

	it("is single-use", async () => {
		const appToken = await createAppIdentity();
		const issued = await requestPairingCode(appToken);
		expect((await claimPairingCode(issued.code, "first")).status).toBe(201);
		expect((await claimPairingCode(issued.code, "second")).status).toBe(404);
	});

	it("rejects an expired code", async () => {
		const appToken = await createAppIdentity();
		const issued = await requestPairingCode(appToken);
		await env.DB.prepare("UPDATE pairing_codes SET expires_at = ? WHERE code = ?")
			.bind(Date.now() - 1, issued.code)
			.run();
		expect((await claimPairingCode(issued.code, "late")).status).toBe(404);
	});
});
