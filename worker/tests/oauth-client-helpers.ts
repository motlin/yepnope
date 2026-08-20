import {env, exports} from "cloudflare:workers";
import {DEVICE_CODE_GRANT_TYPE, hashToken, OAUTH_SCOPES} from "../auth";
import {decideDeviceAuthorization} from "../device-authorization";

const API_ORIGIN = "https://yepnope.app";
const MCP_RESOURCE = "https://yepnope.app/mcp";

export interface SeededOAuthMcpClient {
	clientId: string;
	managementId: string;
	refreshTokenId: string;
}

export async function seedOAuthMcpClient(
	userId: string,
	installation: string,
	options: {authorizedAt?: number; expiresAt?: number; name?: string} = {},
): Promise<SeededOAuthMcpClient> {
	const authorizedAt = options.authorizedAt ?? Date.UTC(2000, 0, 1);
	const expiresAt = options.expiresAt ?? Date.UTC(2099, 0, 1);
	const clientId = `test-oauth-client-${installation}`;
	const clientRowId = `test-oauth-client-row-${installation}`;
	const consentId = `test-oauth-consent-${installation}`;
	const refreshTokenId = `test-oauth-refresh-${installation}`;
	const serializedScopes = JSON.stringify([...OAUTH_SCOPES]);
	const serializedResources = JSON.stringify([MCP_RESOURCE]);
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO oauth_client (id, client_id, user_id, created_at, updated_at, name, redirect_uris) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?)",
		).bind(
			clientRowId,
			clientId,
			userId,
			authorizedAt,
			authorizedAt,
			options.name ?? `Test MCP client ${installation}`,
			JSON.stringify([`http://127.0.0.1/callback/${installation}`]),
		),
		env.DB.prepare(
			"INSERT INTO oauth_consent " +
				"(id, client_id, user_id, resources, scopes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).bind(consentId, clientId, userId, serializedResources, serializedScopes, authorizedAt, authorizedAt),
		env.DB.prepare(
			"INSERT INTO oauth_refresh_token " +
				"(id, token, client_id, user_id, resources, expires_at, created_at, scopes) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).bind(
			refreshTokenId,
			`stored-test-refresh-token-${installation}`,
			clientId,
			userId,
			serializedResources,
			expiresAt,
			authorizedAt,
			serializedScopes,
		),
	]);
	return {
		clientId,
		managementId: await hashToken(`connected-mcp-client\0${userId}\0${clientId}`),
		refreshTokenId,
	};
}

// 📟 The device grant, driven end to end against the real endpoints. Only the human tap is
// simulated, and it is simulated by calling the same function the browser route calls, so a test
// that authenticates this way is holding a token the deployment actually minted.

const DEVICE_SCOPE = OAUTH_SCOPES.join(" ");

export interface RegisteredDeviceClient {
	clientId: string;
}

export interface IssuedDeviceCode {
	deviceCode: string;
	userCode: string;
}

export interface AuthorizedDeviceClient extends RegisteredDeviceClient, IssuedDeviceCode {
	accessToken: string;
	managementId: string;
	refreshToken: string;
}

export async function registerDeviceClient(name = "YepNope hook"): Promise<RegisteredDeviceClient> {
	const response = await exports.default.fetch(`${API_ORIGIN}/api/auth/oauth2/register`, {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify({
			client_name: name,
			grant_types: [DEVICE_CODE_GRANT_TYPE, "refresh_token"],
			resources: [MCP_RESOURCE],
			scope: DEVICE_SCOPE,
			token_endpoint_auth_method: "none",
		}),
	});
	if (response.status !== 201) {
		throw new Error(`expected device client registration 201, got ${response.status}`);
	}
	const body = await response.json<{client_id: string}>();
	return {clientId: body.client_id};
}

export async function requestDeviceCode(clientId: string): Promise<IssuedDeviceCode> {
	const response = await exports.default.fetch(`${API_ORIGIN}/api/auth/device/code`, {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify({client_id: clientId, resource: MCP_RESOURCE, scope: DEVICE_SCOPE}),
	});
	if (response.status !== 200) {
		throw new Error(`expected device code 200, got ${response.status}`);
	}
	const body = await response.json<{device_code: string; user_code: string}>();
	return {deviceCode: body.device_code, userCode: body.user_code};
}

export async function pollDeviceToken(clientId: string, deviceCode: string): Promise<Response> {
	return exports.default.fetch(`${API_ORIGIN}/api/auth/oauth2/token`, {
		method: "POST",
		headers: {"Content-Type": "application/x-www-form-urlencoded"},
		body: new URLSearchParams({
			client_id: clientId,
			device_code: deviceCode,
			grant_type: DEVICE_CODE_GRANT_TYPE,
			resource: MCP_RESOURCE,
		}),
	});
}

/** RFC 8628 refuses a second poll inside the interval, which a test crosses in microseconds. */
export async function forgetDeviceCodePoll(deviceCode: string): Promise<void> {
	await env.DB.prepare("UPDATE device_code SET last_polled_at = NULL WHERE device_code = ?").bind(deviceCode).run();
}

async function seedVerifiedUser(userId: string): Promise<void> {
	const now = Date.now();
	await env.DB.prepare(
		"INSERT OR IGNORE INTO user (id, email, email_verified, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
	)
		.bind(userId, `${userId}@example.com`, now, now)
		.run();
}

export async function authorizeDeviceClient(userId: string, name?: string): Promise<AuthorizedDeviceClient> {
	await seedVerifiedUser(userId);
	const {clientId} = await registerDeviceClient(name);
	const issued = await requestDeviceCode(clientId);
	const decision = await decideDeviceAuthorization(
		env.DB,
		userId,
		issued.userCode,
		"approved",
		MCP_RESOURCE,
		Date.now(),
	);
	if (decision.status !== "decided") {
		throw new Error(`expected the device code to be approvable, got ${decision.status}`);
	}
	const exchanged = await pollDeviceToken(clientId, issued.deviceCode);
	if (exchanged.status !== 200) {
		throw new Error(`expected device token 200, got ${exchanged.status}`);
	}
	const tokens = await exchanged.json<{access_token: string; refresh_token: string}>();
	return {
		...issued,
		accessToken: tokens.access_token,
		clientId,
		managementId: await hashToken(`connected-mcp-client\0${userId}\0${clientId}`),
		refreshToken: tokens.refresh_token,
	};
}
