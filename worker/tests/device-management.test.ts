import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe, expect, it} from "vitest";
import {hashToken} from "../auth";
import type {UserDurableObject} from "../user-do";
import {
	API_ORIGIN,
	cookieFrom,
	createVerifiedBrowserSession,
	humanVerificationHeader,
	nextMessage,
	required,
	worker,
} from "./helpers";
import {seedOAuthMcpClient} from "./oauth-client-helpers";

const AUTHORIZED_AT = Date.UTC(2000, 0, 1);

async function seedPushDevice(userId: string, endpoint: string, label: string): Promise<string> {
	const subscription = {endpoint, keys: {p256dh: "fake-public-key", auth: "fake-auth-secret"}};
	const stub = env.USER_DO.getByName(userId);
	await stub.registerDevice(subscription, label);
	await runInDurableObject(stub, (_instance: UserDurableObject, state) => {
		state.storage.sql.exec("UPDATE devices SET created_at = ?", AUTHORIZED_AT);
	});
	return hashToken(endpoint);
}

async function accountRequest(cookie: string, path: string, method = "GET", label?: string): Promise<Response> {
	return worker.fetch(`${API_ORIGIN}${path}`, {
		method,
		headers: {
			Cookie: cookie,
			...(label === undefined ? {} : {"Content-Type": "application/json"}),
		},
		...(label === undefined ? {} : {body: JSON.stringify({label})}),
	});
}

describe("connected MCP client and browser notification management", () => {
	it("requires a verified browser session and never treats a legacy machine token as account authorization", async () => {
		const session = await createVerifiedBrowserSession("account-api-alice@example.com");
		const legacyToken = "test-legacy-machine-token";
		await env.DB.prepare("INSERT INTO machine_tokens (token_hash, user_id, label, created_at) VALUES (?, ?, ?, ?)")
			.bind(await hashToken(legacyToken), session.userId, "Legacy test machine", AUTHORIZED_AT)
			.run();

		const unauthenticated = await worker.fetch(`${API_ORIGIN}/api/v1/account/devices`);
		const legacyMachineAuthenticated = await worker.fetch(`${API_ORIGIN}/api/v1/account/devices`, {
			headers: {Authorization: `Bearer ${legacyToken}`},
		});

		expect([unauthenticated.status, legacyMachineAuthenticated.status]).toStrictEqual([401, 401]);
	});

	it("lists one redacted entry per OAuth installation while keeping browser sessions and push separate", async () => {
		const email = "connected-client-list-alice@example.com";
		const session = await createVerifiedBrowserSession(email);
		const client = await seedOAuthMcpClient(session.userId, "alice-laptop", {
			authorizedAt: AUTHORIZED_AT,
			name: "Alice Codex",
		});
		await env.DB.prepare(
			"INSERT INTO oauth_refresh_token " +
				"(id, token, client_id, user_id, resources, expires_at, created_at, scopes) " +
				"SELECT ?, ?, client_id, user_id, resources, expires_at, ?, scopes FROM oauth_refresh_token WHERE id = ?",
		)
			.bind(
				"test-oauth-refresh-alice-laptop-rotated",
				"stored-test-refresh-token-alice-laptop-rotated",
				Date.UTC(2000, 0, 2),
				client.refreshTokenId,
			)
			.run();
		const secondBrowserSession = await worker.fetch(`${API_ORIGIN}/api/auth/sign-in/email`, {
			method: "POST",
			headers: {
				...humanVerificationHeader("sign_in"),
				"Content-Type": "application/json",
				Origin: API_ORIGIN,
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0",
			},
			body: JSON.stringify({email, password: "correct-horse-battery-staple"}),
		});
		expect(secondBrowserSession.status).toBe(200);
		const firstSessionResponse = await worker.fetch(`${API_ORIGIN}/api/auth/get-session`, {
			headers: {Cookie: session.cookie},
		});
		const secondSessionResponse = await worker.fetch(`${API_ORIGIN}/api/auth/get-session`, {
			headers: {Cookie: cookieFrom(secondBrowserSession)},
		});
		const firstSessionId = (await firstSessionResponse.json<{session: {id: string}}>()).session.id;
		const secondSessionId = (await secondSessionResponse.json<{session: {id: string}}>()).session.id;
		const sessionExpiry = Date.UTC(2050, 0, 1);
		await env.DB.batch([
			env.DB.prepare(
				"UPDATE session SET created_at = ?, updated_at = ?, expires_at = ?, user_agent = ? WHERE id = ?",
			).bind(Date.UTC(2000, 0, 1), Date.UTC(2000, 0, 2), sessionExpiry, "TestBrowser/1.0", firstSessionId),
			env.DB.prepare("UPDATE session SET created_at = ?, updated_at = ?, expires_at = ? WHERE id = ?").bind(
				Date.UTC(2000, 0, 3),
				Date.UTC(2000, 0, 4),
				sessionExpiry,
				secondSessionId,
			),
		]);
		const endpoint = "https://push.example.com/send/alice-browser";
		const pushDeviceId = await seedPushDevice(session.userId, endpoint, "Alice browser");

		const response = await accountRequest(session.cookie, "/api/v1/account/devices");
		const body = await response.json();
		expect({body, status: response.status}).toStrictEqual({
			body: {
				browser_sessions: [
					{
						id: await hashToken(`browser-session\0${session.userId}\0${secondSessionId}`),
						display_name: "Chrome on Windows",
						created_at: Date.UTC(2000, 0, 3),
						last_active_at: Date.UTC(2000, 0, 4),
						expires_at: sessionExpiry,
						current: false,
					},
					{
						id: await hashToken(`browser-session\0${session.userId}\0${firstSessionId}`),
						display_name: "Browser on unknown platform",
						created_at: Date.UTC(2000, 0, 1),
						last_active_at: Date.UTC(2000, 0, 2),
						expires_at: sessionExpiry,
						current: true,
					},
				],
				connected_mcp_clients: [
					{
						id: client.managementId,
						display_name: "Alice Codex",
						authorized_at: AUTHORIZED_AT,
						last_used_at: null,
						granted_scopes: ["offline_access", "openid", "yepnope:questions"],
						status: "active",
						revoked_at: null,
					},
				],
				push_devices: [{id: pushDeviceId, label: "Alice browser", created_at: AUTHORIZED_AT}],
			},
			status: 200,
		});
		expect(
			await env.DB.prepare("SELECT count(*) AS browser_sessions FROM session WHERE user_id = ?")
				.bind(session.userId)
				.first(),
		).toStrictEqual({browser_sessions: 2});
		const serialized = JSON.stringify(body);
		expect([
			serialized.includes(client.clientId),
			serialized.includes(firstSessionId),
			serialized.includes(secondSessionId),
			serialized.includes("stored-test-refresh-token"),
			serialized.includes(endpoint),
			serialized.includes("fake-auth-secret"),
		]).toStrictEqual([false, false, false, false, false, false]);
	});

	it("revokes clients independently, rejects cross-account IDs, and broadcasts last-client AFK shutdown", async () => {
		const alice = await createVerifiedBrowserSession("connected-client-revoke-alice@example.com");
		const bob = await createVerifiedBrowserSession("connected-client-revoke-bob@example.com");
		const first = await seedOAuthMcpClient(alice.userId, "alice-first", {name: "Alice Codex"});
		const second = await seedOAuthMcpClient(alice.userId, "alice-second", {name: "Alice Claude"});
		const bobClient = await seedOAuthMcpClient(bob.userId, "bob-first", {name: "Bob Codex"});
		const stub = env.USER_DO.getByName(alice.userId);
		expect(await stub.setAfk(true, true)).toStrictEqual({status: "updated", afk: true});

		const streamResponse = await worker.fetch(`${API_ORIGIN}/api/v1/current-deck/stream`, {
			headers: {Cookie: alice.cookie, Upgrade: "websocket"},
		});
		const socket = required(streamResponse.webSocket ?? undefined, "current deck websocket");
		const initial = nextMessage(socket);
		socket.accept();
		expect(JSON.parse(await initial)).toStrictEqual({
			type: "current_deck",
			afk: true,
			connected_mcp_client_count: 2,
			current_deck: [],
		});

		const denied = await accountRequest(
			bob.cookie,
			`/api/v1/account/connected-mcp-clients/${first.managementId}`,
			"DELETE",
		);
		expect(denied.status).toBe(404);
		const afterFirstRevocation = nextMessage(socket);
		const revokedFirst = await accountRequest(
			alice.cookie,
			`/api/v1/account/connected-mcp-clients/${first.managementId}`,
			"DELETE",
		);
		expect({body: await revokedFirst.json(), status: revokedFirst.status}).toStrictEqual({
			body: {status: "ok", connected_mcp_client_count: 1},
			status: 200,
		});
		expect(JSON.parse(await afterFirstRevocation)).toStrictEqual({
			type: "current_deck",
			afk: true,
			connected_mcp_client_count: 1,
			current_deck: [],
		});
		expect(await stub.getAfk(true)).toBe(true);

		const afterLastRevocation = nextMessage(socket);
		const revokedLast = await accountRequest(
			alice.cookie,
			`/api/v1/account/connected-mcp-clients/${second.managementId}`,
			"DELETE",
		);
		expect({body: await revokedLast.json(), status: revokedLast.status}).toStrictEqual({
			body: {status: "ok", connected_mcp_client_count: 0},
			status: 200,
		});
		expect(JSON.parse(await afterLastRevocation)).toStrictEqual({
			type: "current_deck",
			afk: false,
			connected_mcp_client_count: 0,
			current_deck: [],
		});
		expect(await stub.getAfk(true)).toBe(false);
		expect(
			await env.DB.prepare(
				"SELECT client_id, revoked IS NOT NULL AS revoked FROM oauth_refresh_token " +
					"WHERE client_id IN (?, ?, ?) ORDER BY client_id",
			)
				.bind(first.clientId, second.clientId, bobClient.clientId)
				.all(),
		).toStrictEqual({
			success: true,
			results: [
				{client_id: first.clientId, revoked: 1},
				{client_id: second.clientId, revoked: 1},
				{client_id: bobClient.clientId, revoked: 0},
			],
			meta: expect.any(Object),
		});
		socket.close();
	});
});
