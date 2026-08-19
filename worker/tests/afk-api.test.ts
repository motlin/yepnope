import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe, expect, it} from "vitest";
import {hashToken} from "../auth";
import {API_ORIGIN, createVerifiedBrowserSession, nextMessage, required, worker} from "./helpers";
import {seedOAuthMcpClient} from "./oauth-client-helpers";

async function putAfk(cookie: string, afk: boolean): Promise<Response> {
	return worker.fetch(`${API_ORIGIN}/api/v1/afk`, {
		method: "PUT",
		headers: {Cookie: cookie},
		body: JSON.stringify({afk}),
	});
}

describe("AFK mode", () => {
	it("defaults a new account with zero connected MCP clients to off", async () => {
		const session = await createVerifiedBrowserSession("afk-default-alice@example.com");
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/afk`, {headers: {Cookie: session.cookie}});
		expect({body: await response.json(), status: response.status}).toStrictEqual({body: {afk: false}, status: 200});
		await runInDurableObject(env.USER_DO.getByName(session.userId), (_instance, state) => {
			expect(state.storage.sql.exec("SELECT afk FROM state").one()).toStrictEqual({afk: 0});
		});
		const streamResponse = await worker.fetch(`${API_ORIGIN}/api/v1/current-deck/stream`, {
			headers: {Cookie: session.cookie, Upgrade: "websocket"},
		});
		const socket = required(streamResponse.webSocket ?? undefined, "current deck websocket");
		const state = nextMessage(socket);
		socket.accept();
		expect(JSON.parse(await state)).toStrictEqual({
			type: "current_deck",
			afk: false,
			connected_mcp_client_count: 0,
			current_deck: [],
		});
		socket.close();
	});

	it("requires authentication", async () => {
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/afk`);
		expect(response.status).toBe(401);
	});

	it("rejects AFK enablement until an OAuth MCP host or CLI client is authorized", async () => {
		const session = await createVerifiedBrowserSession("afk-authorization-alice@example.com");
		const legacyToken = "test-paired-legacy-token";
		await env.DB.prepare("INSERT INTO machine_tokens (token_hash, user_id, label, created_at) VALUES (?, ?, ?, ?)")
			.bind(await hashToken(legacyToken), session.userId, "Legacy paired CLI", Date.UTC(2000, 0, 1))
			.run();
		const denied = await putAfk(session.cookie, true);
		expect({body: await denied.json(), status: denied.status}).toStrictEqual({
			body: {
				error: "connected_mcp_client_required",
				message: "Authorize an MCP host or OAuth CLI client before turning AFK on.",
			},
			status: 409,
		});

		await seedOAuthMcpClient(session.userId, "afk-authorized");
		const enabled = await putAfk(session.cookie, true);
		expect({body: await enabled.json(), status: enabled.status}).toStrictEqual({
			body: {afk: true},
			status: 200,
		});
	});

	it("rejects malformed AFK input", async () => {
		const session = await createVerifiedBrowserSession("afk-malformed-alice@example.com");
		await seedOAuthMcpClient(session.userId, "afk-malformed");
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/afk`, {
			method: "PUT",
			headers: {Cookie: session.cookie},
			body: JSON.stringify({afk: "sideways"}),
		});
		expect(response.status).toBe(400);
	});

	it("uses connected-client authorization for legacy question API routing", async () => {
		const session = await createVerifiedBrowserSession("afk-question-gate-alice@example.com");
		const request = async () =>
			worker.fetch(`${API_ORIGIN}/api/v1/questions`, {
				method: "POST",
				headers: {Cookie: session.cookie},
				body: JSON.stringify({project: "Example project", questions: [{title: "Ship?", body: ""}]}),
			});
		const disabled = await request();
		expect({body: await disabled.json(), status: disabled.status}).toStrictEqual({
			body: {
				error: "afk_off",
				message:
					"The user is at their keyboard, so questions are not being routed to their phone. " +
					"Use the AskUserQuestion tool instead of ask_yep_nope for this question.",
			},
			status: 409,
		});

		await seedOAuthMcpClient(session.userId, "afk-question-gate");
		expect((await putAfk(session.cookie, true)).status).toBe(200);
		const enabled = await request();
		expect({body: await enabled.json(), status: enabled.status}).toStrictEqual({
			body: {batch_id: expect.any(String), question_ids: [expect.any(String)]},
			status: 201,
		});
	});
});
