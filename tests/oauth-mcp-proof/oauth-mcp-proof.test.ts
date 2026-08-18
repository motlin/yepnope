import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {decodeJwt} from "jose";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {
	PROOF_SCOPES,
	QUESTION_SCOPE,
	createFixedClient,
	createProofBrowserSession,
	proofPkce,
	signProofJwt,
	startProofServer,
	type OAuthTokens,
	type ProofServer,
} from "./fixture";

const OAUTH_STATE = "proof-state-00000000";

interface AuthorizationResult {
	code: string;
	state: string;
}

async function redirectUrl(response: Response): Promise<string> {
	const value = response.headers.get("location");
	if (value !== null) {
		return value;
	}
	if (response.ok) {
		return ((await response.json()) as {url: string}).url;
	}
	throw new Error(`expected redirect URL from ${response.url}: ${await response.text()}`);
}

async function authorize(
	proof: ProofServer,
	cookie: string,
	clientId: string,
	redirectUri: string,
	accept: boolean,
): Promise<URL> {
	const pkce = await proofPkce();
	const query = new URLSearchParams({
		client_id: clientId,
		code_challenge: pkce.challenge,
		code_challenge_method: "S256",
		redirect_uri: redirectUri,
		resource: proof.resource,
		response_type: "code",
		scope: PROOF_SCOPES.join(" "),
		state: OAUTH_STATE,
		prompt: "consent",
	});
	const authorization = await fetch(`${proof.issuer}/oauth2/authorize?${query}`, {
		headers: {Accept: "text/html", Cookie: cookie},
		redirect: "manual",
	});
	const consentUrl = new URL(await redirectUrl(authorization), proof.origin);
	const consent = await fetch(`${proof.issuer}/oauth2/consent`, {
		method: "POST",
		headers: {"Content-Type": "application/json", Cookie: cookie, Origin: proof.origin},
		body: JSON.stringify({accept, oauth_query: consentUrl.searchParams.toString()}),
		redirect: "manual",
	});
	if (!consent.ok) {
		throw new Error(`consent failed with ${String(consent.status)}: ${await consent.text()}`);
	}
	return new URL(await redirectUrl(consent));
}

async function approvedAuthorization(
	proof: ProofServer,
	cookie: string,
	clientId: string,
	redirectUri: string,
): Promise<AuthorizationResult> {
	const callback = await authorize(proof, cookie, clientId, redirectUri, true);
	const code = callback.searchParams.get("code");
	const state = callback.searchParams.get("state");
	if (code === null || state === null) {
		throw new Error("approved authorization did not return code and state");
	}
	return {code, state};
}

async function exchangeAuthorizationCode(
	proof: ProofServer,
	clientId: string,
	redirectUri: string,
	code: string,
): Promise<Response> {
	const {verifier} = await proofPkce();
	return fetch(`${proof.issuer}/oauth2/token`, {
		method: "POST",
		headers: {"Content-Type": "application/x-www-form-urlencoded"},
		body: new URLSearchParams({
			client_id: clientId,
			code,
			code_verifier: verifier,
			grant_type: "authorization_code",
			redirect_uri: redirectUri,
			resource: proof.resource,
		}),
	});
}

async function refresh(proof: ProofServer, clientId: string, refreshToken: string): Promise<Response> {
	return fetch(`${proof.issuer}/oauth2/token`, {
		method: "POST",
		headers: {"Content-Type": "application/x-www-form-urlencoded"},
		body: new URLSearchParams({
			client_id: clientId,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			resource: proof.resource,
		}),
	});
}

async function mcpRequest(proof: ProofServer, token: string): Promise<Response> {
	return fetch(proof.resource, {
		method: "POST",
		headers: {
			Accept: "application/json, text/event-stream",
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			id: 1,
			jsonrpc: "2.0",
			method: "initialize",
			params: {
				capabilities: {},
				clientInfo: {name: "negative-proof-client", version: "1.0.0"},
				protocolVersion: "2025-11-25",
			},
		}),
	});
}

describe("Better Auth OAuth and remote MCP local proof", () => {
	let proof: ProofServer;
	let cookie: string;
	let clientId: string;
	let redirectUri: string;
	let tokens: OAuthTokens;
	let authorizationCode: string;

	beforeAll(async () => {
		proof = await startProofServer();
		cookie = await createProofBrowserSession(proof);
		redirectUri = `${proof.origin}/proof/callback`;
		clientId = await createFixedClient(proof, cookie, redirectUri);
		const authorization = await approvedAuthorization(proof, cookie, clientId, redirectUri);
		expect(authorization.state).toBe(OAUTH_STATE);
		authorizationCode = authorization.code;
		const tokenResponse = await exchangeAuthorizationCode(proof, clientId, redirectUri, authorization.code);
		expect(tokenResponse.status).toBe(200);
		tokens = (await tokenResponse.json()) as OAuthTokens;
	});

	afterAll(async () => {
		await proof.close();
	});

	it("publishes issuer and protected-resource discovery for the MCP resource", async () => {
		const [authorizationMetadata, protectedResourceMetadata] = await Promise.all([
			fetch(`${proof.issuer}/.well-known/oauth-authorization-server`).then(async (response) => {
				const body: unknown = await response.json();
				return body;
			}),
			fetch(`${proof.origin}/.well-known/oauth-protected-resource`).then(async (response) => {
				const body: unknown = await response.json();
				return body;
			}),
		]);

		expect(authorizationMetadata).toStrictEqual({
			acr_values_supported: ["0"],
			authorization_endpoint: `${proof.issuer}/oauth2/authorize`,
			authorization_response_iss_parameter_supported: true,
			backchannel_logout_session_supported: true,
			backchannel_logout_supported: true,
			claims_parameter_supported: true,
			claims_supported: ["sub", "iss", "aud", "exp", "iat", "sid", "scope", "azp"],
			code_challenge_methods_supported: ["S256"],
			dpop_signing_alg_values_supported: ["EdDSA", "ES256", "ES512", "PS256", "RS256"],
			end_session_endpoint: `${proof.issuer}/oauth2/end-session`,
			grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
			id_token_signing_alg_values_supported: ["EdDSA"],
			introspection_endpoint: `${proof.issuer}/oauth2/introspect`,
			introspection_endpoint_auth_methods_supported: [
				"client_secret_basic",
				"client_secret_post",
				"private_key_jwt",
			],
			introspection_endpoint_auth_signing_alg_values_supported: [
				"RS256",
				"RS384",
				"RS512",
				"PS256",
				"PS384",
				"PS512",
				"ES256",
				"ES384",
				"ES512",
				"EdDSA",
			],
			issuer: proof.issuer,
			jwks_uri: `${proof.issuer}/jwks`,
			prompt_values_supported: ["login", "consent", "create", "select_account", "none"],
			request_parameter_supported: false,
			request_uri_parameter_supported: false,
			response_modes_supported: ["query"],
			response_types_supported: ["code"],
			revocation_endpoint: `${proof.issuer}/oauth2/revoke`,
			revocation_endpoint_auth_methods_supported: [
				"client_secret_basic",
				"client_secret_post",
				"private_key_jwt",
			],
			revocation_endpoint_auth_signing_alg_values_supported: [
				"RS256",
				"RS384",
				"RS512",
				"PS256",
				"PS384",
				"PS512",
				"ES256",
				"ES384",
				"ES512",
				"EdDSA",
			],
			scopes_supported: [...PROOF_SCOPES],
			subject_types_supported: ["public"],
			token_endpoint: `${proof.issuer}/oauth2/token`,
			token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "private_key_jwt"],
			token_endpoint_auth_signing_alg_values_supported: [
				"RS256",
				"RS384",
				"RS512",
				"PS256",
				"PS384",
				"PS512",
				"ES256",
				"ES384",
				"ES512",
				"EdDSA",
			],
			userinfo_endpoint: `${proof.issuer}/oauth2/userinfo`,
		});
		expect(protectedResourceMetadata).toStrictEqual({
			authorization_servers: [proof.issuer],
			bearer_methods_supported: ["header"],
			dpop_signing_alg_values_supported: ["EdDSA", "ES256", "ES512", "PS256", "RS256"],
			resource: proof.resource,
			scopes_supported: [QUESTION_SCOPE],
		});
	});

	it("issues audience-bound scoped tokens with PKCE and rotates refresh tokens without replay", async () => {
		expect(tokens).toStrictEqual({
			access_token: expect.any(String),
			expires_at: expect.any(Number),
			expires_in: 60,
			id_token: expect.any(String),
			refresh_token: expect.any(String),
			scope: PROOF_SCOPES.join(" "),
			token_type: "Bearer",
		});
		expect(decodeJwt(tokens.access_token)).toStrictEqual({
			aud: [proof.resource, `${proof.issuer}/oauth2/userinfo`],
			azp: clientId,
			client_id: clientId,
			exp: expect.any(Number),
			iat: expect.any(Number),
			iss: proof.issuer,
			jti: expect.any(String),
			scope: PROOF_SCOPES.join(" "),
			sid: expect.any(String),
			sub: expect.any(String),
		});
		const firstRefresh = await refresh(proof, clientId, tokens.refresh_token);
		if (!firstRefresh.ok) {
			throw new Error(`refresh failed with ${String(firstRefresh.status)}: ${await firstRefresh.text()}`);
		}
		const rotatedTokens = (await firstRefresh.json()) as OAuthTokens;
		expect(rotatedTokens).toStrictEqual({
			access_token: expect.any(String),
			expires_at: expect.any(Number),
			expires_in: 60,
			id_token: expect.any(String),
			refresh_token: expect.any(String),
			scope: PROOF_SCOPES.join(" "),
			token_type: "Bearer",
		});
		const replay = await refresh(proof, clientId, tokens.refresh_token);
		expect({body: await replay.json(), status: replay.status}).toStrictEqual({
			body: {error: "invalid_grant", error_description: "invalid refresh token"},
			status: 400,
		});
		const codeReplay = await exchangeAuthorizationCode(proof, clientId, redirectUri, authorizationCode);
		expect({body: await codeReplay.json(), status: codeReplay.status}).toStrictEqual({
			body: {error: "invalid_grant", error_description: "invalid code"},
			status: 400,
		});
	});

	it("rejects an unapproved authorization request without issuing a code", async () => {
		const callback = await authorize(proof, cookie, clientId, redirectUri, false);
		expect(Object.fromEntries(callback.searchParams)).toStrictEqual({
			error: "access_denied",
			error_description: "User denied access",
			iss: proof.issuer,
			state: OAUTH_STATE,
		});
	});

	it("calls a protected tool with the issued token", async () => {
		const transport = new StreamableHTTPClientTransport(new URL(proof.resource), {
			requestInit: {headers: {Authorization: `Bearer ${tokens.access_token}`}},
		});
		const client = new Client({name: "oauth-proof-client", version: "1.0.0"});
		await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
		const result = await client.callTool({name: "protected_echo", arguments: {text: "proof text"}});
		expect(result).toStrictEqual({
			content: [
				{
					text: expect.stringMatching(/^\{"subject":".+","text":"proof text"\}$/),
					type: "text",
				},
			],
		});
		await client.close();
	});

	it("propagates client cancellation to a long-running protected tool", async () => {
		const transport = new StreamableHTTPClientTransport(new URL(proof.resource), {
			requestInit: {headers: {Authorization: `Bearer ${tokens.access_token}`}},
		});
		const client = new Client({name: "oauth-cancellation-proof-client", version: "1.0.0"});
		await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
		const abortController = new AbortController();
		const call = client.callTool(
			{name: "ask_yep_nope", arguments: {question: "Should cancellation retract this question?"}},
			undefined,
			{signal: abortController.signal},
		);
		setTimeout(() => {
			abortController.abort();
		}, 25);
		const outcome = await call.then(
			(value) => ({status: "resolved" as const, value}),
			(reason: unknown) => ({reason, status: "rejected" as const}),
		);
		if (outcome.status !== "rejected" || !(outcome.reason instanceof Error)) {
			throw new Error("cancelled MCP call did not reject with an error");
		}
		expect({message: outcome.reason.message, name: outcome.reason.name}).toStrictEqual({
			message: "MCP error -32001: AbortError: This operation was aborted",
			name: "McpError",
		});
		await Promise.race([
			proof.cancellationObserved,
			new Promise((_, reject) => {
				setTimeout(() => {
					reject(new Error("server did not observe cancellation"));
				}, 1_000);
			}),
		]);
		await client.close();
	});

	it("fails closed for wrong-audience, insufficient-scope, and expired credentials", async () => {
		const now = Math.floor(Date.now() / 1_000);
		const signed = async (audience: string, scope: string, expiresAt: number) =>
			signProofJwt(proof, {
				aud: audience,
				client_id: clientId,
				exp: expiresAt,
				iat: now - 1,
				iss: proof.issuer,
				scope,
				sub: "alice-proof-user",
			});

		const wrongAudience = await mcpRequest(proof, await signed(`${proof.origin}/wrong`, QUESTION_SCOPE, now + 60));
		const insufficientScope = await mcpRequest(proof, await signed(proof.resource, "openid", now + 60));
		const expired = await mcpRequest(proof, await signed(proof.resource, QUESTION_SCOPE, now - 60));
		expect([
			{challenge: wrongAudience.headers.get("www-authenticate"), status: wrongAudience.status},
			{challenge: insufficientScope.headers.get("www-authenticate"), status: insufficientScope.status},
			{challenge: expired.headers.get("www-authenticate"), status: expired.status},
		]).toStrictEqual([
			{
				challenge: `Bearer resource_metadata="${proof.origin}/.well-known/oauth-protected-resource/mcp", scope="${PROOF_SCOPES.join(" ")}"`,
				status: 401,
			},
			{
				challenge: `Bearer error="insufficient_scope", scope="${QUESTION_SCOPE}", resource_metadata="${proof.origin}/.well-known/oauth-protected-resource/mcp", error_description="access token is missing required scope: ${QUESTION_SCOPE}"`,
				status: 403,
			},
			{
				challenge: `Bearer resource_metadata="${proof.origin}/.well-known/oauth-protected-resource/mcp", scope="${PROOF_SCOPES.join(" ")}"`,
				status: 401,
			},
		]);
	});
});
