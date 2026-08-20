import {env} from "cloudflare:workers";
import {describe, expect, it, vi} from "vitest";
import {API_ORIGIN, createVerifiedBrowserSession, worker} from "./helpers";
import {authorizeDeviceClient} from "./oauth-client-helpers";

const MCP_RESOURCE = `${API_ORIGIN}/mcp`;
// The exact shape of the credential this service used to mint, kept only so a test can prove it is
// refused now. `ynp_live_` and 43 base64url characters.
const RETIRED_MACHINE_TOKEN = `ynp_live_${"A".repeat(43)}`;
const ACCESS_TOKEN_LIFETIME_MILLISECONDS = 10 * 60 * 1_000;

// 🪝 The Claude Code hook is a shell command, not an MCP client, so it holds a credential of its own.
// These tests pin the one property that makes that acceptable: the credential is an ordinary OAuth
// grant, refused by the same rules and revoked from the same page as every other client.

async function postHook(token: string): Promise<Response> {
	return worker.fetch(`${API_ORIGIN}/api/v1/hook`, {
		method: "POST",
		headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
		body: JSON.stringify({hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {}}),
	});
}

async function refreshTokens(clientId: string, refreshToken: string): Promise<Response> {
	return worker.fetch(`${API_ORIGIN}/api/auth/oauth2/token`, {
		method: "POST",
		headers: {"Content-Type": "application/x-www-form-urlencoded"},
		body: new URLSearchParams({
			client_id: clientId,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			resource: MCP_RESOURCE,
		}),
	});
}

describe("hook authentication", () => {
	it("accepts a device-authorized access token", async () => {
		const authorized = await authorizeDeviceClient("hook-valid-token");
		const response = await postHook(authorized.accessToken);
		expect({body: await response.json(), status: response.status}).toStrictEqual({body: {}, status: 200});
	});

	it("refuses an access token whose lifetime has run out", async () => {
		const authorized = await authorizeDeviceClient("hook-expired-token");
		const beforeExpiry = await postHook(authorized.accessToken);
		vi.useFakeTimers({shouldAdvanceTime: true});
		try {
			// The signature is still correct and the grant is still live. Only the clock moved.
			vi.setSystemTime(Date.now() + ACCESS_TOKEN_LIFETIME_MILLISECONDS + 60_000);
			const afterExpiry = await postHook(authorized.accessToken);
			expect({afterExpiry: afterExpiry.status, beforeExpiry: beforeExpiry.status}).toStrictEqual({
				afterExpiry: 401,
				beforeExpiry: 200,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps working across a refresh, and retires the rotated token", async () => {
		const authorized = await authorizeDeviceClient("hook-refresh");
		const refreshed = await refreshTokens(authorized.clientId, authorized.refreshToken);
		const rotated = await refreshed.json<{access_token: string; refresh_token: string}>();

		const withRotated = await postHook(rotated.access_token);
		const replayed = await refreshTokens(authorized.clientId, authorized.refreshToken);
		expect({
			refreshStatus: refreshed.status,
			replayStatus: replayed.status,
			rotatedIsNew: rotated.refresh_token !== authorized.refreshToken,
			withRotatedStatus: withRotated.status,
		}).toStrictEqual({
			refreshStatus: 200,
			replayStatus: 400,
			rotatedIsNew: true,
			withRotatedStatus: 200,
		});
	});

	it("stops the hook the moment the account revokes its client in Settings", async () => {
		const session = await createVerifiedBrowserSession();
		const authorized = await authorizeDeviceClient(session.userId, "Craig's laptop hook");
		expect((await postHook(authorized.accessToken)).status).toStrictEqual(200);

		const revoked = await worker.fetch(
			`${API_ORIGIN}/api/v1/account/connected-mcp-clients/${authorized.managementId}`,
			{method: "DELETE", headers: {Cookie: session.cookie}},
		);

		// 🔌 The access token is still unexpired and still correctly signed. Revocation has to bite
		// anyway, which is the whole reason the hook stopped carrying a credential of its own.
		const afterRevocation = await postHook(authorized.accessToken);
		const refreshAfterRevocation = await refreshTokens(authorized.clientId, authorized.refreshToken);
		expect({
			afterRevocation: afterRevocation.status,
			refreshAfterRevocation: refreshAfterRevocation.status,
			revoked: {body: await revoked.json(), status: revoked.status},
		}).toStrictEqual({
			afterRevocation: 401,
			refreshAfterRevocation: 400,
			revoked: {body: {status: "ok", connected_mcp_client_count: 0}, status: 200},
		});
	});

	it("refuses every shape of credential this service no longer issues", async () => {
		const authorized = await authorizeDeviceClient("hook-rejected-credentials");
		const statuses = await Promise.all(
			[
				RETIRED_MACHINE_TOKEN,
				"machine-token-hook-rejected-credentials",
				`${authorized.accessToken}tampered`,
				authorized.refreshToken,
			].map(async (token) => (await postHook(token)).status),
		);
		expect(statuses).toStrictEqual([401, 401, 401, 401]);
	});

	it("refuses a token whose grant lost its consent", async () => {
		const authorized = await authorizeDeviceClient("hook-consent-withdrawn");
		await env.DB.prepare("DELETE FROM oauth_consent WHERE client_id = ?").bind(authorized.clientId).run();
		expect((await postHook(authorized.accessToken)).status).toStrictEqual(401);
	});
});
