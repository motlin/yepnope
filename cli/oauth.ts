import {z} from "zod";

// 🔑 An RFC 8628 public client. It has no secret to protect, no callback port to open, and no
// password to be typed into it: the only thing it ever holds is a refresh token the account approved
// in a browser and can revoke there.

const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const OAUTH_SCOPE = "openid offline_access yepnope:questions";

const registrationSchema = z.object({client_id: z.string().min(1)});

const deviceCodeSchema = z.object({
	device_code: z.string().min(1),
	expires_in: z.number().int().positive(),
	interval: z.number().int().positive(),
	user_code: z.string().min(1),
	verification_uri: z.string().min(1),
	verification_uri_complete: z.string().min(1).optional(),
});

const tokenSchema = z.object({
	access_token: z.string().min(1),
	expires_in: z.number().int().positive(),
	refresh_token: z.string().min(1),
});

const errorSchema = z.object({error: z.string().min(1), error_description: z.string().optional()});

export type DeviceCode = z.infer<typeof deviceCodeSchema>;

export interface TokenSet {
	accessToken: string;
	expiresAt: number;
	refreshToken: string;
}

export type PollOutcome =
	| {status: "issued"; tokens: TokenSet}
	| {status: "pending"}
	| {status: "slow_down"}
	| {status: "unreachable"}
	| {status: "failed"; reason: string};

class OAuthError extends Error {}

function resource(baseUrl: string): string {
	return new URL("/mcp", baseUrl).toString();
}

async function readError(response: Response): Promise<string> {
	const parsed = errorSchema.safeParse(await response.json().catch(() => null));
	return parsed.success ? (parsed.data.error_description ?? parsed.data.error) : `HTTP ${String(response.status)}`;
}

async function postForm(baseUrl: string, path: string, fields: Record<string, string>): Promise<Response> {
	return fetch(new URL(path, baseUrl), {
		method: "POST",
		headers: {"Content-Type": "application/x-www-form-urlencoded"},
		body: new URLSearchParams(fields),
	});
}

/**
 * Dynamic client registration. Each installation registers itself once, so revoking one machine's
 * hook in Settings never touches another's.
 */
export async function registerClient(baseUrl: string, clientName: string): Promise<string> {
	const response = await fetch(new URL("/api/auth/oauth2/register", baseUrl), {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify({
			client_name: clientName,
			grant_types: [DEVICE_CODE_GRANT_TYPE, "refresh_token"],
			resources: [resource(baseUrl)],
			scope: OAUTH_SCOPE,
			token_endpoint_auth_method: "none",
		}),
	});
	if (response.status !== 201) {
		throw new OAuthError(`could not register with ${baseUrl}: ${await readError(response)}`);
	}
	return registrationSchema.parse(await response.json()).client_id;
}

export async function requestDeviceCode(baseUrl: string, clientId: string): Promise<DeviceCode> {
	const response = await postForm(baseUrl, "/api/auth/device/code", {
		client_id: clientId,
		resource: resource(baseUrl),
		scope: OAUTH_SCOPE,
	});
	if (!response.ok) {
		throw new OAuthError(`could not start device authorization: ${await readError(response)}`);
	}
	return deviceCodeSchema.parse(await response.json());
}

function issued(payload: unknown): TokenSet {
	const tokens = tokenSchema.parse(payload);
	return {
		accessToken: tokens.access_token,
		// 🕐 A minute of slack. A token that expires between this check and the request it authorizes
		// would turn a permission prompt into a silent abstention.
		expiresAt: Date.now() + (tokens.expires_in - 60) * 1_000,
		refreshToken: tokens.refresh_token,
	};
}

export async function pollDeviceToken(baseUrl: string, clientId: string, deviceCode: string): Promise<PollOutcome> {
	// 📡 A poll that dies on the network says nothing about the approval. The code is still live on
	// the service, so the loop keeps waiting instead of abandoning a code the user is about to approve.
	let response: Response;
	try {
		response = await postForm(baseUrl, "/api/auth/oauth2/token", {
			client_id: clientId,
			device_code: deviceCode,
			grant_type: DEVICE_CODE_GRANT_TYPE,
			resource: resource(baseUrl),
		});
	} catch {
		return {status: "unreachable"};
	}
	if (response.ok) {
		return {status: "issued", tokens: issued(await response.json())};
	}
	const parsed = errorSchema.safeParse(await response.json().catch(() => null));
	if (!parsed.success) {
		return {status: "failed", reason: `HTTP ${String(response.status)}`};
	}
	if (parsed.data.error === "authorization_pending") {
		return {status: "pending"};
	}
	if (parsed.data.error === "slow_down") {
		return {status: "slow_down"};
	}
	return {status: "failed", reason: parsed.data.error_description ?? parsed.data.error};
}

export async function refreshTokens(baseUrl: string, clientId: string, refreshToken: string): Promise<TokenSet> {
	const response = await postForm(baseUrl, "/api/auth/oauth2/token", {
		client_id: clientId,
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		resource: resource(baseUrl),
	});
	if (!response.ok) {
		throw new OAuthError(`could not refresh the YepNope credential: ${await readError(response)}`);
	}
	return issued(await response.json());
}

/** Best effort. A credential the account already revoked is gone either way. */
export async function revokeRefreshToken(baseUrl: string, clientId: string, refreshToken: string): Promise<void> {
	await postForm(baseUrl, "/api/auth/oauth2/revoke", {
		client_id: clientId,
		token: refreshToken,
		token_type_hint: "refresh_token",
	}).catch(() => undefined);
}
