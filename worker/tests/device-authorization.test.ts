import {env} from "cloudflare:workers";
import {beforeAll, describe, expect, it} from "vitest";
import {DEVICE_CODE_GRANT_TYPE} from "../auth";
import {API_ORIGIN, createVerifiedBrowserSession, worker} from "./helpers";
import {
	authorizeDeviceClient,
	forgetDeviceCodePoll,
	pollDeviceToken,
	registerDeviceClient,
	requestDeviceCode,
} from "./oauth-client-helpers";

const MCP_RESOURCE = `${API_ORIGIN}/mcp`;

interface DeviceCodeResponse {
	device_code: string;
	expires_in: number;
	interval: number;
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
}

async function deviceAuthorizationRequest(body: Record<string, unknown>): Promise<Response> {
	return worker.fetch(`${API_ORIGIN}/api/auth/device/code`, {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify(body),
	});
}

async function describeUserCode(cookie: string, userCode: string): Promise<Response> {
	return worker.fetch(`${API_ORIGIN}/api/v1/device-authorization?user_code=${encodeURIComponent(userCode)}`, {
		headers: {Cookie: cookie},
	});
}

async function decideUserCode(cookie: string, userCode: string, decision: string): Promise<Response> {
	return worker.fetch(`${API_ORIGIN}/api/v1/device-authorization?decision=${decision}`, {
		method: "POST",
		headers: {Cookie: cookie, "Content-Type": "application/json"},
		body: JSON.stringify({user_code: userCode}),
	});
}

describe("RFC 8628 device authorization", () => {
	// 💸 A verified session costs a sign-up, a verification mail, and two deliberate half-second
	// response floors. Every test below needs one and none of them need a different one, so the file
	// pays for two: the account under test and a stranger for the isolation case.
	let account: Awaited<ReturnType<typeof createVerifiedBrowserSession>>;
	let stranger: Awaited<ReturnType<typeof createVerifiedBrowserSession>>;

	beforeAll(async () => {
		// One at a time: two concurrent sign-ups race for the same verification mailbox.
		account = await createVerifiedBrowserSession();
		stranger = await createVerifiedBrowserSession();
	});

	it("issues a user code that names this deployment's own verification page", async () => {
		const {clientId} = await registerDeviceClient();
		const response = await deviceAuthorizationRequest({
			client_id: clientId,
			resource: MCP_RESOURCE,
			scope: "openid offline_access yepnope:questions",
		});
		const body = await response.json<DeviceCodeResponse>();
		expect({
			expires_in: body.expires_in,
			interval: body.interval,
			status: response.status,
			userCodeShape: /^[A-Z0-9]{8}$/.test(body.user_code),
			verification_uri: body.verification_uri,
			verification_uri_complete: body.verification_uri_complete,
		}).toStrictEqual({
			expires_in: 600,
			interval: 5,
			status: 200,
			userCodeShape: true,
			verification_uri: `${API_ORIGIN}/device`,
			verification_uri_complete: `${API_ORIGIN}/device?user_code=${body.user_code}`,
		});
	});

	it("refuses to register a device client that also asks for a browser redirect", async () => {
		const response = await worker.fetch(`${API_ORIGIN}/api/auth/oauth2/register`, {
			method: "POST",
			headers: {"Content-Type": "application/json"},
			body: JSON.stringify({
				client_name: "Confused client",
				grant_types: [DEVICE_CODE_GRANT_TYPE, "authorization_code"],
				redirect_uris: ["http://127.0.0.1:7777/callback"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
			}),
		});
		expect({status: response.status, body: await response.json()}).toStrictEqual({
			status: 400,
			body: {
				error: "invalid_client_metadata",
				error_description: "Client registration metadata is not permitted",
			},
		});
	});

	it("holds the caller at authorization_pending until the account approves, then issues one token set", async () => {
		const {clientId} = await registerDeviceClient();
		const issued = await requestDeviceCode(clientId);

		const pending = await pollDeviceToken(clientId, issued.deviceCode);
		expect({status: pending.status, body: await pending.json()}).toStrictEqual({
			status: 400,
			body: {error: "authorization_pending", error_description: "Authorization pending"},
		});

		const slowDown = await pollDeviceToken(clientId, issued.deviceCode);
		expect(await slowDown.json()).toStrictEqual({
			error: "slow_down",
			error_description: "Polling too frequently",
		});
		await forgetDeviceCodePoll(issued.deviceCode);

		const described = await describeUserCode(account.cookie, issued.userCode);
		expect({status: described.status, body: await described.json()}).toStrictEqual({
			status: 200,
			body: {
				client_name: "YepNope hook",
				scopes: ["offline_access", "openid", "yepnope:questions"],
				status: "pending",
				user_code: issued.userCode,
			},
		});

		const approved = await decideUserCode(account.cookie, issued.userCode, "approved");
		expect({status: approved.status, body: await approved.json()}).toStrictEqual({
			status: 200,
			body: {status: "decided", decision: "approved"},
		});

		const exchanged = await pollDeviceToken(clientId, issued.deviceCode);
		const tokens = await exchanged.json<{
			access_token: string;
			expires_in: number;
			refresh_token: string;
			scope: string;
			token_type: string;
		}>();
		expect({
			expires_in: tokens.expires_in,
			hasAccessToken: tokens.access_token.length > 0,
			hasRefreshToken: tokens.refresh_token.length > 0,
			scope: tokens.scope,
			status: exchanged.status,
			token_type: tokens.token_type,
		}).toStrictEqual({
			expires_in: 600,
			hasAccessToken: true,
			hasRefreshToken: true,
			scope: "openid offline_access yepnope:questions",
			status: 200,
			token_type: "Bearer",
		});

		// One approval, one token set: the code is consumed by the exchange that redeemed it.
		await forgetDeviceCodePoll(issued.deviceCode);
		const replayed = await pollDeviceToken(clientId, issued.deviceCode);
		expect(await replayed.json()).toStrictEqual({
			error: "invalid_grant",
			error_description: "Invalid device code",
		});
	});

	it("records a consent the account can see and revoke", async () => {
		// The one case that owns its account, because it asserts the whole connected-client list.
		const isolated = await createVerifiedBrowserSession();
		const {clientId} = await registerDeviceClient("Craig's laptop hook");
		const issued = await requestDeviceCode(clientId);
		await decideUserCode(isolated.cookie, issued.userCode, "approved");
		await pollDeviceToken(clientId, issued.deviceCode);

		const devices = await worker.fetch(`${API_ORIGIN}/api/v1/account/devices`, {
			headers: {Cookie: isolated.cookie},
		});
		const body = await devices.json<{
			connected_mcp_clients: Array<{display_name: string; granted_scopes: string[]; status: string}>;
		}>();
		expect(
			body.connected_mcp_clients.map((client) => ({
				display_name: client.display_name,
				granted_scopes: client.granted_scopes,
				status: client.status,
			})),
		).toStrictEqual([
			{
				display_name: "Craig's laptop hook",
				granted_scopes: ["offline_access", "openid", "yepnope:questions"],
				status: "active",
			},
		]);
	});

	it("denies a code the account rejects, and never mints a token for it", async () => {
		const {clientId} = await registerDeviceClient();
		const issued = await requestDeviceCode(clientId);

		const denied = await decideUserCode(account.cookie, issued.userCode, "denied");
		expect({status: denied.status, body: await denied.json()}).toStrictEqual({
			status: 200,
			body: {status: "decided", decision: "denied"},
		});

		const rejected = await pollDeviceToken(clientId, issued.deviceCode);
		expect({status: rejected.status, body: await rejected.json()}).toStrictEqual({
			status: 400,
			body: {error: "access_denied", error_description: "Access denied"},
		});
		expect(
			await env.DB.prepare("SELECT count(*) AS consents FROM oauth_consent WHERE client_id = ?")
				.bind(clientId)
				.first(),
		).toStrictEqual({consents: 0});
	});

	it("refuses a code that expired before anyone approved it", async () => {
		const {clientId} = await registerDeviceClient();
		const issued = await requestDeviceCode(clientId);
		await env.DB.prepare("UPDATE device_code SET expires_at = ? WHERE device_code = ?")
			.bind(Date.now() - 1_000, issued.deviceCode)
			.run();

		const described = await describeUserCode(account.cookie, issued.userCode);
		expect({status: described.status, body: await described.json()}).toStrictEqual({
			status: 410,
			body: {status: "expired"},
		});
		const approved = await decideUserCode(account.cookie, issued.userCode, "approved");
		expect(approved.status).toStrictEqual(410);
		const exchanged = await pollDeviceToken(clientId, issued.deviceCode);
		expect(await exchanged.json()).toStrictEqual({
			error: "expired_token",
			error_description: "Device code has expired",
		});
	});

	it("hides another account's pending code, and refuses to approve it", async () => {
		const {clientId} = await registerDeviceClient();
		const issued = await requestDeviceCode(clientId);
		// The owner reading it first is what claims the code for that account.
		await describeUserCode(account.cookie, issued.userCode);

		const peeked = await describeUserCode(stranger.cookie, issued.userCode);
		expect({status: peeked.status, body: await peeked.json()}).toStrictEqual({
			status: 404,
			body: {status: "not_found"},
		});
		const stolen = await decideUserCode(stranger.cookie, issued.userCode, "approved");
		expect(stolen.status).toStrictEqual(404);
	});

	it("never offers a code that did not ask for this deployment's resource", async () => {
		const {clientId} = await registerDeviceClient();
		const unbound = await worker.fetch(`${API_ORIGIN}/api/auth/device/code`, {
			method: "POST",
			headers: {"Content-Type": "application/json"},
			body: JSON.stringify({client_id: clientId, scope: "openid offline_access yepnope:questions"}),
		});
		const {user_code: userCode} = await unbound.json<{user_code: string}>();

		// 🙈 Approving it would mint a token that authorizes nothing, so it is not a decision to put
		// in front of a person at all.
		const described = await describeUserCode(account.cookie, userCode);
		expect({status: described.status, body: await described.json()}).toStrictEqual({
			status: 404,
			body: {status: "not_found"},
		});
	});

	it("requires the account's own browser session to approve anything", async () => {
		const {clientId} = await registerDeviceClient();
		const issued = await requestDeviceCode(clientId);
		const anonymous = await worker.fetch(`${API_ORIGIN}/api/v1/device-authorization?decision=approved`, {
			method: "POST",
			headers: {"Content-Type": "application/json"},
			body: JSON.stringify({user_code: issued.userCode}),
		});
		expect(anonymous.status).toStrictEqual(401);
	});

	it("normalizes the dashes and lower case a person types", async () => {
		const {clientId} = await registerDeviceClient();
		const issued = await requestDeviceCode(clientId);
		const typed = `${issued.userCode.slice(0, 4).toLowerCase()}-${issued.userCode.slice(4).toLowerCase()}`;

		const described = await describeUserCode(account.cookie, typed);
		expect({
			status: described.status,
			userCode: (await described.json<{user_code: string}>()).user_code,
		}).toStrictEqual({status: 200, userCode: issued.userCode});
	});

	it("gives its tokens the same audience and scope a browser-authorized client gets", async () => {
		const authorized = await authorizeDeviceClient("device-audience");
		const [, payload] = authorized.accessToken.split(".");
		const claims = JSON.parse(atob((payload ?? "").replaceAll("-", "+").replaceAll("_", "/"))) as {
			aud: string | string[];
			azp: string;
			client_id: string;
			scope: string;
			sid?: string;
			sub: string;
		};
		expect({
			aud: [claims.aud].flat().includes(MCP_RESOURCE),
			azp: claims.azp,
			client_id: claims.client_id,
			hasSessionClaim: claims.sid !== undefined,
			scope: claims.scope,
			sub: claims.sub,
		}).toStrictEqual({
			aud: true,
			azp: authorized.clientId,
			client_id: authorized.clientId,
			// 🪪 A device grant is approved in the app, not delegated from a live browser session, so
			// it carries no `sid` and cannot be validated under the delegated grant's rules.
			hasSessionClaim: false,
			scope: "openid offline_access yepnope:questions",
			sub: "device-audience",
		});
	});
});
