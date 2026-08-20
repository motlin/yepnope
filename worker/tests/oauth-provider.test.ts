import {env} from "cloudflare:workers";
import {decodeJwt} from "jose";
import {describe, expect, it} from "vitest";
import {MCP_RESOURCE_PATH, OAUTH_SCOPES} from "../auth";
import {
	API_ORIGIN,
	authenticationWithMailbox,
	cookieFrom,
	createVerifiedBrowserSession,
	emailLink,
	postAuthentication,
	required,
	worker,
} from "./helpers";

const ISSUER = `${API_ORIGIN}/api/auth`;
const RESOURCE = `${API_ORIGIN}${MCP_RESOURCE_PATH}`;
const REDIRECT_URI = "http://127.0.0.1:45678/callback/oauth-test";
const OAUTH_STATE = "oauth-state-00000000";
const CODE_VERIFIER = "oauth-verifier-000000000000000000000000000000000000000000000000";
const ACCOUNT_PASSWORD = "correct-horse-battery-staple";

interface RegisteredClient {
	clientId: string;
	registrationResponse: Record<string, unknown>;
}

interface OAuthTokenResponse {
	access_token: string;
	expires_at: number;
	expires_in: number;
	id_token: string;
	refresh_token: string;
	scope: string;
	token_type: string;
}

async function codeChallenge(): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(CODE_VERIFIER));
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

function registrationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		application_type: "native",
		client_name: "Codex OAuth test client",
		grant_types: ["authorization_code", "refresh_token"],
		redirect_uris: [REDIRECT_URI],
		response_types: ["code"],
		scope: OAUTH_SCOPES.join(" "),
		token_endpoint_auth_method: "none",
		...overrides,
	};
}

async function registerClient(overrides: Record<string, unknown> = {}, cookie?: string): Promise<RegisteredClient> {
	const response = await worker.fetch(`${ISSUER}/oauth2/register`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(cookie === undefined ? {} : {Cookie: cookie, Origin: API_ORIGIN}),
		},
		body: JSON.stringify(registrationBody(overrides)),
	});
	if (!response.ok) {
		throw new Error(`client registration failed with ${String(response.status)}: ${await response.text()}`);
	}
	const registrationResponse = await response.json<Record<string, unknown>>();
	const clientId = registrationResponse["client_id"];
	if (typeof clientId !== "string") {
		throw new Error("client registration returned no client id");
	}
	return {clientId, registrationResponse};
}

async function responseRedirect(response: Response): Promise<string> {
	const location = response.headers.get("location");
	if (location !== null) {
		return location;
	}
	const body: unknown = await response.json();
	if (typeof body !== "object" || body === null || !("url" in body) || typeof body.url !== "string") {
		throw new Error("OAuth response returned no redirect URL");
	}
	return body.url;
}

async function authorizationQuery(clientId: string): Promise<URLSearchParams> {
	return new URLSearchParams({
		client_id: clientId,
		code_challenge: await codeChallenge(),
		code_challenge_method: "S256",
		prompt: "consent",
		redirect_uri: REDIRECT_URI,
		resource: RESOURCE,
		response_type: "code",
		scope: OAUTH_SCOPES.join(" "),
		state: OAUTH_STATE,
	});
}

async function authorize(cookie: string, clientId: string, accept: boolean): Promise<URL> {
	const query = await authorizationQuery(clientId);
	const authorization = await worker.fetch(`${ISSUER}/oauth2/authorize?${query}`, {
		headers: {Accept: "text/html", Cookie: cookie},
		redirect: "manual",
	});
	const consentUrl = new URL(await responseRedirect(authorization), API_ORIGIN);
	const consent = await worker.fetch(`${ISSUER}/oauth2/consent`, {
		method: "POST",
		headers: {"Content-Type": "application/json", Cookie: cookie, Origin: API_ORIGIN},
		body: JSON.stringify({accept, oauth_query: consentUrl.searchParams.toString()}),
		redirect: "manual",
	});
	if (!consent.ok) {
		throw new Error(`consent failed with ${String(consent.status)}: ${await consent.text()}`);
	}
	return new URL(await responseRedirect(consent));
}

async function approvedCode(cookie: string, clientId: string): Promise<string> {
	const callback = await authorize(cookie, clientId, true);
	const code = callback.searchParams.get("code");
	if (code === null) {
		throw new Error("approved authorization returned no code");
	}
	return code;
}

async function exchangeCode(clientId: string, code: string, verifier = CODE_VERIFIER): Promise<Response> {
	return worker.fetch(`${ISSUER}/oauth2/token`, {
		method: "POST",
		headers: {"Content-Type": "application/x-www-form-urlencoded"},
		body: new URLSearchParams({
			client_id: clientId,
			code,
			code_verifier: verifier,
			grant_type: "authorization_code",
			redirect_uri: REDIRECT_URI,
			resource: RESOURCE,
		}),
	});
}

async function refresh(clientId: string, refreshToken: string): Promise<Response> {
	return worker.fetch(`${ISSUER}/oauth2/token`, {
		method: "POST",
		headers: {"Content-Type": "application/x-www-form-urlencoded"},
		body: new URLSearchParams({
			client_id: clientId,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			resource: RESOURCE,
		}),
	});
}

describe("Better Auth OAuth MCP provider", () => {
	it("publishes both issuer discovery aliases and protected-resource metadata through the public Worker", async () => {
		const responses = await Promise.all([
			worker.fetch(`${ISSUER}/.well-known/oauth-authorization-server`),
			worker.fetch(`${API_ORIGIN}/.well-known/oauth-authorization-server/api/auth`),
			worker.fetch(`${API_ORIGIN}/.well-known/oauth-protected-resource`),
			worker.fetch(`${API_ORIGIN}/.well-known/oauth-protected-resource/mcp`),
		]);
		const bodies = await Promise.all(responses.map(async (response) => response.json<Record<string, unknown>>()));
		const [issuerPathMetadata, rootMetadata, rootResourceMetadata, pathResourceMetadata] = bodies;
		expect({
			metadataAliasesMatch:
				issuerPathMetadata === undefined
					? false
					: JSON.stringify(issuerPathMetadata) === JSON.stringify(rootMetadata),
			resourceAliasesMatch:
				rootResourceMetadata === undefined
					? false
					: JSON.stringify(rootResourceMetadata) === JSON.stringify(pathResourceMetadata),
			status: responses.map((response) => response.status),
		}).toStrictEqual({metadataAliasesMatch: true, resourceAliasesMatch: true, status: [200, 200, 200, 200]});
		expect({
			authorization_endpoint: issuerPathMetadata?.["authorization_endpoint"],
			code_challenge_methods_supported: issuerPathMetadata?.["code_challenge_methods_supported"],
			device_authorization_endpoint: issuerPathMetadata?.["device_authorization_endpoint"],
			grant_types_supported: issuerPathMetadata?.["grant_types_supported"],
			introspection_endpoint: issuerPathMetadata?.["introspection_endpoint"],
			issuer: issuerPathMetadata?.["issuer"],
			registration_endpoint: issuerPathMetadata?.["registration_endpoint"],
			revocation_endpoint: issuerPathMetadata?.["revocation_endpoint"],
			scopes_supported: issuerPathMetadata?.["scopes_supported"],
			token_endpoint: issuerPathMetadata?.["token_endpoint"],
		}).toStrictEqual({
			authorization_endpoint: `${ISSUER}/oauth2/authorize`,
			code_challenge_methods_supported: ["S256"],
			device_authorization_endpoint: `${ISSUER}/device/code`,
			grant_types_supported: [
				"authorization_code",
				"refresh_token",
				"urn:ietf:params:oauth:grant-type:device_code",
			],
			issuer: ISSUER,
			introspection_endpoint: `${ISSUER}/oauth2/introspect`,
			registration_endpoint: `${ISSUER}/oauth2/register`,
			revocation_endpoint: `${ISSUER}/oauth2/revoke`,
			scopes_supported: [...OAUTH_SCOPES],
			token_endpoint: `${ISSUER}/oauth2/token`,
		});
		expect(rootResourceMetadata).toStrictEqual({
			authorization_servers: [ISSUER],
			bearer_methods_supported: ["header"],
			dpop_signing_alg_values_supported: ["EdDSA", "ES256", "ES512", "PS256", "RS256"],
			resource: RESOURCE,
			scopes_supported: ["yepnope:questions"],
		});
	});

	it("registers only bounded native public clients with loopback redirects", async () => {
		const registered = await registerClient();
		const {cookie} = await createVerifiedBrowserSession("oauth-client-metadata@example.com");
		const publicClientResponse = await worker.fetch(
			`${ISSUER}/oauth2/public-client?client_id=${encodeURIComponent(registered.clientId)}`,
			{headers: {Cookie: cookie}},
		);
		const publicClient = await publicClientResponse.json<Record<string, unknown>>();
		const invalidRegistrations = await Promise.all([
			worker.fetch(`${ISSUER}/oauth2/register`, {
				method: "POST",
				headers: {"Content-Type": "application/json"},
				body: JSON.stringify(registrationBody({redirect_uris: ["https://client.example.com/callback"]})),
			}),
			worker.fetch(`${ISSUER}/oauth2/register`, {
				method: "POST",
				headers: {"Content-Type": "application/json"},
				body: JSON.stringify(registrationBody({scope: `${OAUTH_SCOPES.join(" ")} admin`})),
			}),
			worker.fetch(`${ISSUER}/oauth2/register`, {
				method: "POST",
				headers: {"Content-Type": "application/json"},
				body: JSON.stringify(registrationBody({scope: `${OAUTH_SCOPES.join(" ")} yepnope:afk`})),
			}),
			worker.fetch(`${ISSUER}/oauth2/register`, {
				method: "POST",
				headers: {"Content-Type": "application/json"},
				body: JSON.stringify(registrationBody({token_endpoint_auth_method: "client_secret_post"})),
			}),
			worker.fetch(`${ISSUER}/oauth2/register`, {
				method: "POST",
				headers: {"Content-Type": "application/json"},
				body: JSON.stringify(registrationBody({application_type: "web"})),
			}),
		]);
		expect({
			invalid: await Promise.all(
				invalidRegistrations.map(async (response) => ({body: await response.json(), status: response.status})),
			),
			publicClient: {
				client_id: publicClient["client_id"],
				client_name: publicClient["client_name"],
				client_secret: publicClient["client_secret"],
				status: publicClientResponse.status,
			},
			registered: {
				application_type: registered.registrationResponse["application_type"],
				client_id: registered.registrationResponse["client_id"],
				client_secret: registered.registrationResponse["client_secret"],
				grant_types: registered.registrationResponse["grant_types"],
				redirect_uris: registered.registrationResponse["redirect_uris"],
				response_types: registered.registrationResponse["response_types"],
				token_endpoint_auth_method: registered.registrationResponse["token_endpoint_auth_method"],
			},
		}).toStrictEqual({
			invalid: Array.from({length: 5}, () => ({
				body: {
					error: "invalid_client_metadata",
					error_description: "Client registration metadata is not permitted",
				},
				status: 400,
			})),
			publicClient: {
				client_id: registered.clientId,
				client_name: "Codex OAuth test client",
				client_secret: undefined,
				status: 200,
			},
			registered: {
				application_type: "native",
				client_id: expect.any(String),
				client_secret: undefined,
				grant_types: ["authorization_code", "refresh_token"],
				redirect_uris: [REDIRECT_URI],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
			},
		});
	});

	it("registers native clients that omit the optional application type", async () => {
		const response = await worker.fetch(`${ISSUER}/oauth2/register`, {
			method: "POST",
			headers: {"Content-Type": "application/json"},
			body: JSON.stringify({
				client_name: "Claude Code (yepnope)",
				grant_types: ["authorization_code", "refresh_token"],
				redirect_uris: [REDIRECT_URI],
				response_types: ["code"],
				scope: OAUTH_SCOPES.join(" "),
				token_endpoint_auth_method: "none",
			}),
		});
		const body = await response.json<Record<string, unknown>>();
		expect({
			application_type: body["application_type"],
			client_id: body["client_id"],
			client_secret: body["client_secret"],
			redirect_uris: body["redirect_uris"],
			status: response.status,
			token_endpoint_auth_method: body["token_endpoint_auth_method"],
		}).toStrictEqual({
			application_type: "native",
			client_id: expect.any(String),
			client_secret: undefined,
			redirect_uris: [REDIRECT_URI],
			status: 201,
			token_endpoint_auth_method: "none",
		});
	});

	it("preserves a signed authorization request through sign-in and required email verification", async () => {
		const {authentication, mailbox} = authenticationWithMailbox();
		const email = "oauth-unverified@example.com";
		const signUp = await authentication.handler(
			postAuthentication("sign-up/email", {callbackURL: "/verify-email", email, password: ACCOUNT_PASSWORD}),
		);
		expect({body: await signUp.json(), status: signUp.status}).toStrictEqual({
			body: {message: "If the request can be completed, check your inbox for next steps.", status: true},
			status: 200,
		});

		const {clientId} = await registerClient();
		const unsigned = await worker.fetch(`${ISSUER}/oauth2/authorize?${await authorizationQuery(clientId)}`, {
			headers: {Accept: "application/json"},
			redirect: "manual",
		});
		const signInUrl = new URL(await responseRedirect(unsigned), API_ORIGIN);
		const signedQuery = signInUrl.searchParams.toString();
		expect({
			clientId: signInUrl.searchParams.get("client_id"),
			pathname: signInUrl.pathname,
			resource: signInUrl.searchParams.get("resource"),
			signature: signInUrl.searchParams.get("sig"),
			status: unsigned.status,
		}).toStrictEqual({
			clientId,
			pathname: "/sign-in",
			resource: RESOURCE,
			signature: expect.any(String),
			status: 200,
		});

		const unverifiedSignIn = await authentication.handler(
			postAuthentication("sign-in/email", {
				callbackURL: `/sign-in?${signedQuery}`,
				email,
				oauth_query: signedQuery,
				password: ACCOUNT_PASSWORD,
			}),
		);
		expect({body: await unverifiedSignIn.json(), status: unverifiedSignIn.status}).toStrictEqual({
			body: {
				code: "AUTHENTICATION_FAILED",
				message: "Sign-in failed. Check your email and password, or recover your account.",
			},
			status: 401,
		});
		expect(mailbox).toHaveLength(1);
		const verification = await authentication.handler(
			new Request(emailLink(required(mailbox[0], "verification email"))),
		);
		const verificationLocation = verification.headers.get("location");
		expect({
			cookie: verification.headers.get("set-cookie"),
			location: verificationLocation,
			status: verification.status,
		}).toStrictEqual({cookie: expect.any(String), location: `/sign-in?${signedQuery}`, status: 302});

		const continuedAuthorization = await worker.fetch(`${ISSUER}/oauth2/authorize?${signedQuery}`, {
			headers: {Accept: "application/json", Cookie: cookieFrom(verification)},
			redirect: "manual",
		});
		const consentUrl = new URL(await responseRedirect(continuedAuthorization), API_ORIGIN);
		expect({
			clientId: consentUrl.searchParams.get("client_id"),
			pathname: consentUrl.pathname,
			resource: consentUrl.searchParams.get("resource"),
			status: continuedAuthorization.status,
		}).toStrictEqual({clientId, pathname: "/oauth/consent", resource: RESOURCE, status: 200});
	});

	it("issues scoped audience-bound tokens with PKCE and rejects denial, replay, expiry, and invalid requests", async () => {
		const {cookie, userId} = await createVerifiedBrowserSession("oauth-alice@example.com");
		const {clientId} = await registerClient();
		const denied = await authorize(cookie, clientId, false);
		expect(Object.fromEntries(denied.searchParams)).toStrictEqual({
			error: "access_denied",
			error_description: "User denied access",
			iss: ISSUER,
			state: OAUTH_STATE,
		});

		const pkceCode = await approvedCode(cookie, clientId);
		const wrongVerifier = await exchangeCode(clientId, pkceCode, `${CODE_VERIFIER}wrong`);
		expect({body: await wrongVerifier.json(), status: wrongVerifier.status}).toStrictEqual({
			body: {error: "invalid_request", error_description: "code verification failed"},
			status: 401,
		});
		const code = await approvedCode(cookie, clientId);
		const tokenResponse = await exchangeCode(clientId, code);
		if (!tokenResponse.ok) {
			throw new Error(
				`token exchange failed with ${String(tokenResponse.status)}: ${await tokenResponse.text()}`,
			);
		}
		const tokens = await tokenResponse.json<OAuthTokenResponse>();
		expect(tokens).toStrictEqual({
			access_token: expect.any(String),
			expires_at: expect.any(Number),
			expires_in: 600,
			id_token: expect.any(String),
			refresh_token: expect.any(String),
			scope: OAUTH_SCOPES.join(" "),
			token_type: "Bearer",
		});
		expect(decodeJwt(tokens.access_token)).toStrictEqual({
			aud: [RESOURCE, `${ISSUER}/oauth2/userinfo`],
			azp: clientId,
			client_id: clientId,
			exp: expect.any(Number),
			iat: expect.any(Number),
			iss: ISSUER,
			jti: expect.any(String),
			scope: OAUTH_SCOPES.join(" "),
			sid: expect.any(String),
			sub: userId,
		});
		const introspection = await worker.fetch(`${ISSUER}/oauth2/introspect`, {
			method: "POST",
			headers: {"Content-Type": "application/x-www-form-urlencoded"},
			body: new URLSearchParams({client_id: clientId, token: tokens.access_token}),
		});
		expect({body: await introspection.json(), status: introspection.status}).toStrictEqual({
			body: {error: "invalid_client", error_description: "missing required credentials"},
			status: 401,
		});
		const replay = await exchangeCode(clientId, code);
		expect({body: await replay.json(), status: replay.status}).toStrictEqual({
			body: {error: "invalid_grant", error_description: "invalid code"},
			status: 400,
		});

		const expiringCode = await approvedCode(cookie, clientId);
		await env.DB.prepare(
			"UPDATE verification SET expires_at = ? WHERE json_valid(value) AND json_extract(value, '$.type') = 'authorization_code'",
		)
			.bind(Date.now() - 1)
			.run();
		const expired = await exchangeCode(clientId, expiringCode);
		expect({body: await expired.json(), status: expired.status}).toStrictEqual({
			body: {error: "invalid_grant", error_description: "invalid code"},
			status: 400,
		});

		const invalidAuthorizations = await Promise.all([
			worker.fetch(
				`${ISSUER}/oauth2/authorize?${new URLSearchParams({...Object.fromEntries(await authorizationQuery(clientId)), redirect_uri: "http://127.0.0.1:45679/wrong"})}`,
				{headers: {Cookie: cookie}, redirect: "manual"},
			),
			worker.fetch(
				`${ISSUER}/oauth2/authorize?${new URLSearchParams({...Object.fromEntries(await authorizationQuery(clientId)), resource: `${API_ORIGIN}/wrong`})}`,
				{headers: {Cookie: cookie}, redirect: "manual"},
			),
			worker.fetch(
				`${ISSUER}/oauth2/authorize?${new URLSearchParams({...Object.fromEntries(await authorizationQuery(clientId)), scope: `${OAUTH_SCOPES.join(" ")} admin`})}`,
				{headers: {Cookie: cookie}, redirect: "manual"},
			),
		]);
		expect(
			invalidAuthorizations.map((response) => ({
				location: response.headers.get("location"),
				status: response.status,
			})),
		).toStrictEqual([
			{
				location: `${ISSUER}/error?error=invalid_redirect&error_description=invalid+redirect+uri`,
				status: 302,
			},
			{
				location: `${REDIRECT_URI}?error=invalid_target&error_description=requested+resource+https%3A%2F%2Fyepnope.app%2Fwrong+is+not+configured&state=${OAUTH_STATE}&iss=${encodeURIComponent(ISSUER)}`,
				status: 302,
			},
			{
				location: `${REDIRECT_URI}?error=invalid_scope&error_description=The+following+scopes+are+invalid%3A+admin&state=${OAUTH_STATE}&iss=${encodeURIComponent(ISSUER)}`,
				status: 302,
			},
		]);
	});

	it("rotates and revokes refresh credentials, hashes stored material, and deletes grants with the account", async () => {
		const {cookie, userId} = await createVerifiedBrowserSession("oauth-deletion@example.com");
		const {clientId} = await registerClient({}, cookie);
		expect(
			await env.DB.prepare("SELECT client_id, user_id FROM oauth_client WHERE client_id = ?")
				.bind(clientId)
				.first(),
		).toStrictEqual({client_id: clientId, user_id: userId});
		const code = await approvedCode(cookie, clientId);
		const tokenResponse = await exchangeCode(clientId, code);
		const tokens = await tokenResponse.json<OAuthTokenResponse>();
		const storedBeforeRotation = await env.DB.prepare(
			"SELECT token <> ? AS refresh_token_hashed, user_id, scopes, resources, " +
				"(SELECT count(*) FROM oauth_access_token WHERE user_id = ?) AS access_tokens " +
				"FROM oauth_refresh_token WHERE user_id = ?",
		)
			.bind(tokens.refresh_token, userId, userId)
			.first<Record<string, unknown>>();
		expect(storedBeforeRotation).toStrictEqual({
			access_tokens: 0,
			refresh_token_hashed: 1,
			resources: JSON.stringify([RESOURCE]),
			scopes: JSON.stringify([...OAUTH_SCOPES]),
			user_id: userId,
		});

		const firstRefresh = await refresh(clientId, tokens.refresh_token);
		const rotatedTokens = await firstRefresh.json<OAuthTokenResponse>();
		expect({body: rotatedTokens, status: firstRefresh.status}).toStrictEqual({
			body: {
				access_token: expect.any(String),
				expires_at: expect.any(Number),
				expires_in: 600,
				id_token: expect.any(String),
				refresh_token: expect.any(String),
				scope: OAUTH_SCOPES.join(" "),
				token_type: "Bearer",
			},
			status: 200,
		});
		const rotationReplay = await refresh(clientId, tokens.refresh_token);
		expect({body: await rotationReplay.json(), status: rotationReplay.status}).toStrictEqual({
			body: {error: "invalid_grant", error_description: "invalid refresh token"},
			status: 400,
		});
		const replayedFamily = await refresh(clientId, rotatedTokens.refresh_token);
		expect({body: await replayedFamily.json(), status: replayedFamily.status}).toStrictEqual({
			body: {error: "invalid_grant", error_description: "session not found"},
			status: 400,
		});

		const revocableCode = await approvedCode(cookie, clientId);
		const revocableTokens = await (await exchangeCode(clientId, revocableCode)).json<OAuthTokenResponse>();
		const revocation = await worker.fetch(`${ISSUER}/oauth2/revoke`, {
			method: "POST",
			headers: {"Content-Type": "application/x-www-form-urlencoded"},
			body: new URLSearchParams({
				client_id: clientId,
				token: revocableTokens.refresh_token,
				token_type_hint: "refresh_token",
			}),
		});
		expect({body: await revocation.text(), status: revocation.status}).toStrictEqual({body: "", status: 200});
		const revokedRefresh = await refresh(clientId, revocableTokens.refresh_token);
		expect({body: await revokedRefresh.json(), status: revokedRefresh.status}).toStrictEqual({
			body: {error: "invalid_grant", error_description: "invalid refresh token"},
			status: 400,
		});

		const secondCode = await approvedCode(cookie, clientId);
		const secondTokens = await (await exchangeCode(clientId, secondCode)).json<OAuthTokenResponse>();
		const deletion = await worker.fetch(`${ISSUER}/delete-user`, {
			method: "POST",
			headers: {Cookie: cookie, "Content-Type": "application/json", Origin: API_ORIGIN},
			body: JSON.stringify({password: ACCOUNT_PASSWORD}),
		});
		expect({body: await deletion.json(), status: deletion.status}).toStrictEqual({
			body: {message: "User deleted", success: true},
			status: 200,
		});
		expect(
			await env.DB.prepare(
				"SELECT " +
					"(SELECT count(*) FROM oauth_access_token WHERE user_id = ?) AS access_tokens, " +
					"(SELECT count(*) FROM oauth_refresh_token WHERE user_id = ?) AS refresh_tokens, " +
					"(SELECT count(*) FROM oauth_consent WHERE user_id = ?) AS consents, " +
					"(SELECT count(*) FROM oauth_client WHERE user_id = ?) AS clients, " +
					"(SELECT count(*) FROM verification WHERE json_valid(value) AND json_extract(value, '$.userId') = ?) AS codes",
			)
				.bind(userId, userId, userId, userId, userId)
				.first(),
		).toStrictEqual({access_tokens: 0, clients: 0, codes: 0, consents: 0, refresh_tokens: 0});
		expect(secondTokens.refresh_token).toEqual(expect.any(String));
	});

	it("configures explicit endpoint abuse controls", () => {
		const {authentication} = authenticationWithMailbox();
		const plugin = authentication.options.plugins?.find((candidate) => candidate.id === "oauth-provider");
		if (plugin === undefined) {
			throw new Error("OAuth provider plugin is missing");
		}
		expect(plugin.rateLimit).toStrictEqual([
			{pathMatcher: expect.any(Function), window: 60, max: 20},
			{pathMatcher: expect.any(Function), window: 60, max: 20},
			{pathMatcher: expect.any(Function), window: 60, max: 60},
			{pathMatcher: expect.any(Function), window: 60, max: 20},
			{pathMatcher: expect.any(Function), window: 60, max: 5},
			{pathMatcher: expect.any(Function), window: 60, max: 30},
		]);
	});
});
