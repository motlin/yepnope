import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport, StreamableHTTPError} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {request as httpsRequest} from "node:https";
import {Readable} from "node:stream";
import {expect, test, type APIRequestContext, type BrowserContext, type Page} from "playwright/test";
import {z} from "zod";
import {
	NATIVE_QUESTION_FALLBACK,
	NATIVE_QUESTION_FALLBACK_TEXT,
	TOOL_DESCRIPTION,
	TOOL_INPUT_SCHEMA,
} from "../../shim/tool";

const serverOrigin = "https://127.0.0.1:4173";
const issuer = `${serverOrigin}/api/auth`;
const resource = `${serverOrigin}/mcp`;
const email = "alice-oauth-browser@example.com";
const password = "oauth-browser-password";
const verificationSubject = "Verify your YepNope email";
const scopes = ["openid", "offline_access", "yepnope:questions"] as const;
const redirectUri = "http://127.0.0.1:45678/callback/oauth-browser-client";
const secondRedirectUri = "http://127.0.0.1:45679/callback/oauth-browser-client";
const recoveryRedirectUri = "http://127.0.0.1:45680/callback/oauth-browser-client";
const codeVerifier = "oauth-browser-verifier-00000000000000000000000000000000000000000000";
const secondCodeVerifier = "oauth-browser-verifier-11111111111111111111111111111111111111111111";
const recoveryCodeVerifier = "oauth-browser-verifier-22222222222222222222222222222222222222222222";
const oauthState = "oauth-browser-state-00000000";
const secondOauthState = "oauth-browser-state-11111111";
const recoveryOauthState = "oauth-browser-state-22222222";
const recoveryPassword = "oauth-browser-recovery-password";
const resetSubject = "Reset your YepNope password";
const failedPkceVerifier = "oauth-browser-pkce-verifier-00000000000000000000000000000000000000000";
const failedPkceState = "oauth-browser-pkce-state-00000000";
const routedQuestions = [
	{title: "Approve the OAuth browser change?", body: "Exercise the real MCP Yep outcome."},
	{title: "Reject the OAuth browser risk?", body: "Exercise the real MCP Nope outcome."},
	{title: "Defer the OAuth browser option?", body: "Exercise the real MCP Skip outcome."},
] as const;
const routedAnswer =
	"Approve the OAuth browser change? -> YEP\n" +
	"Reject the OAuth browser risk? -> NOPE\n" +
	"Defer the OAuth browser option? -> SKIPPED. The user declined to decide. " +
	"Leave this alone and report it; do not choose for them.";
const cancelledQuestion = {
	title: "Cancel the OAuth browser request?",
	body: "Exercise MCP cancellation and retract this outstanding question.",
} as const;
const revokedAccessError =
	'Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","error":' +
	'{"code":-32000,"message":"Invalid or revoked access token"},"id":null}';
const expectedTools = {
	tools: [{name: "ask_yep_nope", description: TOOL_DESCRIPTION, inputSchema: TOOL_INPUT_SCHEMA}],
};

const oauthRegistrationSchema = z.object({client_id: z.string().min(1)}).loose();
const oauthTokenSchema = z
	.object({
		access_token: z.string().min(1),
		expires_at: z.number(),
		expires_in: z.number(),
		id_token: z.string().min(1),
		refresh_token: z.string().min(1),
		scope: z.string(),
		token_type: z.literal("Bearer"),
	})
	.strict();
const mailboxSchema = z.object({url: z.url()}).strict();
const sessionSchema = z.object({user: z.object({id: z.string().min(1)}).loose()}).loose();
const authorizationMetadataSchema = z
	.object({
		authorization_endpoint: z.url(),
		code_challenge_methods_supported: z.array(z.string()),
		issuer: z.url(),
		registration_endpoint: z.url(),
		revocation_endpoint: z.url(),
		token_endpoint: z.url(),
	})
	.loose();
const protectedResourceMetadataSchema = z
	.object({
		authorization_servers: z.array(z.url()),
		bearer_methods_supported: z.array(z.string()),
		dpop_signing_alg_values_supported: z.array(z.string()),
		resource: z.url(),
		scopes_supported: z.array(z.string()),
	})
	.loose();
async function codeChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return Buffer.from(digest).toString("base64url");
}

async function registerClient(request: APIRequestContext, name: string, callback: string): Promise<string> {
	const response = await request.post(`${issuer}/oauth2/register`, {
		data: {
			application_type: "native",
			client_name: name,
			grant_types: ["authorization_code", "refresh_token"],
			redirect_uris: [callback],
			resources: [resource],
			response_types: ["code"],
			scope: scopes.join(" "),
			token_endpoint_auth_method: "none",
		},
	});
	expect(response.status()).toBe(201);
	return oauthRegistrationSchema.parse(await response.json()).client_id;
}

async function authorizationUrl(clientId: string, callback: string, verifier: string, state: string): Promise<string> {
	return `${issuer}/oauth2/authorize?${new URLSearchParams({
		client_id: clientId,
		code_challenge: await codeChallenge(verifier),
		code_challenge_method: "S256",
		prompt: "consent",
		redirect_uri: callback,
		resource,
		response_type: "code",
		scope: scopes.join(" "),
		state,
	})}`;
}

async function mailboxLink(request: APIRequestContext, subject = verificationSubject): Promise<string> {
	await expect
		.poll(async () => {
			const response = await request.get("/api/__e2e__/mailbox", {
				params: {email, subject},
			});
			return response.status();
		})
		.toBe(200);
	const response = await request.get("/api/__e2e__/mailbox", {
		params: {email, subject},
	});
	return mailboxSchema.parse(await response.json()).url;
}

async function captureConsentCallback(page: Page, callback: string, buttonName: "Allow" | "Cancel"): Promise<URL> {
	const callbackRequest: {url: string | null} = {url: null};
	const callbackOrigin = new URL(callback).origin;
	await page.route(`${callbackOrigin}/**`, async (route) => {
		callbackRequest.url = route.request().url();
		await route.fulfill({body: "OAuth callback received", contentType: "text/plain", status: 200});
	});
	await page.getByRole("button", {name: buttonName, exact: true}).click();
	await expect.poll(() => callbackRequest.url).not.toBeNull();
	await page.unroute(`${callbackOrigin}/**`);
	if (callbackRequest.url === null) {
		throw new Error("OAuth consent returned no callback URL");
	}
	return new URL(callbackRequest.url);
}

async function signInForAuthorization(page: Page): Promise<void> {
	await expect(page).toHaveURL(/\/sign-in\?.*client_id=.*sig=/);
	await page.getByRole("textbox", {name: "Email"}).fill(email);
	await page.getByLabel("Password").fill(password);
	await page.getByRole("button", {name: "Sign in", exact: true}).click();
	await expect(page.getByRole("heading", {name: "Authorize MCP client"})).toBeVisible();
}

async function exchangeCode(
	request: APIRequestContext,
	clientId: string,
	callback: string,
	verifier: string,
	code: string,
): Promise<z.infer<typeof oauthTokenSchema>> {
	const response = await request.post(`${issuer}/oauth2/token`, {
		form: {
			client_id: clientId,
			code,
			code_verifier: verifier,
			grant_type: "authorization_code",
			redirect_uri: callback,
			resource,
		},
	});
	if (!response.ok()) {
		throw new Error(`OAuth token exchange failed with status ${String(response.status())}`);
	}
	return oauthTokenSchema.parse(await response.json());
}

async function refreshTokens(
	request: APIRequestContext,
	clientId: string,
	refreshToken: string,
): Promise<z.infer<typeof oauthTokenSchema>> {
	const response = await request.post(`${issuer}/oauth2/token`, {
		form: {
			client_id: clientId,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			resource,
		},
	});
	if (!response.ok()) {
		throw new Error(`OAuth token refresh failed with status ${String(response.status())}`);
	}
	return oauthTokenSchema.parse(await response.json());
}

async function refreshFailure(
	request: APIRequestContext,
	clientId: string,
	refreshToken: string,
): Promise<{body: unknown; status: number}> {
	const response = await request.post(`${issuer}/oauth2/token`, {
		form: {
			client_id: clientId,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			resource,
		},
	});
	return {body: await response.json(), status: response.status()};
}

async function rejectedError(promise: Promise<unknown>): Promise<{message: string; name: string}> {
	const outcome = await promise.then(
		() => ({error: null}),
		(error: unknown) => ({error}),
	);
	if (!(outcome.error instanceof Error)) {
		throw new Error("Expected operation to reject with an Error");
	}
	return {message: outcome.error.message, name: outcome.error.name};
}

function authorizationCode(callback: URL): string {
	const code = callback.searchParams.get("code");
	if (code === null) {
		throw new Error("Approved OAuth callback returned no code");
	}
	return code;
}

async function requestBody(body: BodyInit | null | undefined): Promise<string | Uint8Array | undefined> {
	if (body === null || body === undefined) {
		return undefined;
	}
	if (typeof body === "string") {
		return body;
	}
	if (body instanceof URLSearchParams) {
		return body.toString();
	}
	if (body instanceof ArrayBuffer) {
		return new Uint8Array(body);
	}
	if (ArrayBuffer.isView(body)) {
		return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	}
	if (body instanceof Blob) {
		return new Uint8Array(await body.arrayBuffer());
	}
	throw new TypeError(`Unsupported local MCP request body: ${body.constructor.name}`);
}

async function loopbackFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
	const target = new URL(input);
	if (target.origin !== serverOrigin) {
		throw new Error(`Refusing insecure TLS configuration for ${target.origin}`);
	}
	const body = await requestBody(init.body);
	return new Promise<Response>((resolve, reject) => {
		const outgoing = httpsRequest(
			target,
			{
				headers: Object.fromEntries(new Headers(init.headers)),
				method: init.method,
				rejectUnauthorized: false,
				...(init.signal === null || init.signal === undefined ? {} : {signal: init.signal}),
			},
			(incoming) => {
				if (incoming.statusCode === undefined) {
					reject(new Error("Local MCP response is missing its status code"));
					return;
				}
				const abortResponse = (): void => {
					incoming.destroy(new Error("Local MCP request aborted"));
				};
				if (init.signal !== null && init.signal !== undefined) {
					if (init.signal.aborted) {
						abortResponse();
						return;
					}
					init.signal.addEventListener("abort", abortResponse, {once: true});
					incoming.once("close", () => init.signal?.removeEventListener("abort", abortResponse));
				}
				const headers = new Headers();
				for (const [name, value] of Object.entries(incoming.headers)) {
					if (Array.isArray(value)) {
						for (const item of value) {
							headers.append(name, item);
						}
					} else if (value !== undefined) {
						headers.set(name, value);
					}
				}
				resolve(
					new Response(Readable.toWeb(incoming) as unknown as BodyInit, {
						headers,
						status: incoming.statusCode,
						...(incoming.statusMessage === undefined ? {} : {statusText: incoming.statusMessage}),
					}),
				);
			},
		);
		outgoing.once("error", reject);
		outgoing.end(body);
	});
}

async function createProtocolClient(name: string, accessToken: string): Promise<Client> {
	const transport = new StreamableHTTPClientTransport(new URL(resource), {
		fetch: loopbackFetch,
		requestInit: {headers: {Authorization: `Bearer ${accessToken}`}},
	});
	const client = new Client({name, version: "1.0.0"});
	try {
		await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
	} catch (error) {
		if (error instanceof StreamableHTTPError) {
			throw new Error(`Streamable HTTP initialization failed with status ${String(error.code)}`);
		}
		throw error;
	}
	return client;
}

test("browser OAuth authorizes a real Streamable HTTP MCP client", async ({browser, request}) => {
	const contexts: BrowserContext[] = [];
	const clients: Client[] = [];
	try {
		const [authorizationMetadataResponse, protectedResourceMetadataResponse] = await Promise.all([
			request.get("/.well-known/oauth-authorization-server/api/auth"),
			request.get("/.well-known/oauth-protected-resource/mcp"),
		]);
		const authorizationMetadata = authorizationMetadataSchema.parse(await authorizationMetadataResponse.json());
		const protectedResourceMetadata = protectedResourceMetadataSchema.parse(
			await protectedResourceMetadataResponse.json(),
		);
		expect({
			authorization: {
				authorizationEndpoint: authorizationMetadata.authorization_endpoint,
				codeChallengeMethods: authorizationMetadata.code_challenge_methods_supported,
				issuer: authorizationMetadata.issuer,
				registrationEndpoint: authorizationMetadata.registration_endpoint,
				revocationEndpoint: authorizationMetadata.revocation_endpoint,
				tokenEndpoint: authorizationMetadata.token_endpoint,
			},
			protectedResource: protectedResourceMetadata,
			statuses: [authorizationMetadataResponse.status(), protectedResourceMetadataResponse.status()],
		}).toStrictEqual({
			authorization: {
				authorizationEndpoint: `${issuer}/oauth2/authorize`,
				codeChallengeMethods: ["S256"],
				issuer,
				registrationEndpoint: `${issuer}/oauth2/register`,
				revocationEndpoint: `${issuer}/oauth2/revoke`,
				tokenEndpoint: `${issuer}/oauth2/token`,
			},
			protectedResource: {
				authorization_servers: [issuer],
				bearer_methods_supported: ["header"],
				dpop_signing_alg_values_supported: ["EdDSA", "ES256", "ES512", "PS256", "RS256"],
				resource,
				scopes_supported: ["yepnope:questions"],
			},
			statuses: [200, 200],
		});
		const clientId = await registerClient(request, "Browser OAuth MCP client", redirectUri);
		const context = await browser.newContext({ignoreHTTPSErrors: true});
		contexts.push(context);
		const page = await context.newPage();
		await page.goto(await authorizationUrl(clientId, redirectUri, codeVerifier, oauthState));
		await expect(page).toHaveURL(/\/sign-in\?.*client_id=.*sig=/);
		await page.getByRole("button", {name: "Create an account"}).click();
		await expect(page).toHaveURL(/\/register\?.*client_id=.*sig=/);
		await page.getByRole("textbox", {name: "Email"}).fill(email);
		await page.getByLabel("Password").fill(password);
		await page.getByRole("button", {name: "Create account"}).click();
		await expect(page.getByRole("heading", {name: "Verify your email"})).toBeVisible();
		const verificationLink = await mailboxLink(request);
		await page.goto(verificationLink);
		const sessionResponse = await page.request.get("/api/auth/get-session");
		const session = sessionSchema.parse(await sessionResponse.json());
		expect({
			cookieNames: (await context.cookies()).map(({name}) => name),
			sessionUserIdPresent: session.user.id.length > 0,
			sessionStatus: sessionResponse.status(),
		}).toStrictEqual({
			cookieNames: ["__Secure-better-auth.session_token"],
			sessionUserIdPresent: true,
			sessionStatus: 200,
		});
		const sessionCookie = (await context.cookies()).find(
			(cookie) => cookie.name === "__Secure-better-auth.session_token",
		);
		if (sessionCookie === undefined) {
			throw new Error("Verified browser session cookie is missing");
		}
		await expect(page.getByRole("heading", {name: "Authorize MCP client"})).toBeVisible();
		await expect(page.getByText("Browser OAuth MCP client")).toBeVisible();
		await expect(page.getByText("Ask questions")).toBeVisible();
		const callback = await captureConsentCallback(page, redirectUri, "Allow");
		expect({
			codePresent: callback.searchParams.has("code"),
			state: callback.searchParams.get("state"),
		}).toStrictEqual({codePresent: true, state: oauthState});
		const code = authorizationCode(callback);
		const tokens = await exchangeCode(request, clientId, redirectUri, codeVerifier, code);
		expect({expiresIn: tokens.expires_in, scope: tokens.scope, tokenType: tokens.token_type}).toStrictEqual({
			expiresIn: 600,
			scope: scopes.join(" "),
			tokenType: "Bearer",
		});

		const client = await createProtocolClient("browser-oauth-protocol-client", tokens.access_token);
		clients.push(client);
		expect({
			capabilities: client.getServerCapabilities(),
			version: client.getServerVersion(),
		}).toStrictEqual({
			capabilities: {tools: {listChanged: true}},
			version: {name: "yepnope", version: "0.1.0"},
		});
		expect(await client.listTools()).toStrictEqual(expectedTools);
		expect(
			await client.callTool({
				name: "ask_yep_nope",
				arguments: {
					project: "OAuth browser test",
					questions: [{title: "Route this test question?", body: "The user is not AFK yet."}],
				},
			}),
		).toStrictEqual({
			content: [{text: NATIVE_QUESTION_FALLBACK_TEXT, type: "text"}],
			structuredContent: NATIVE_QUESTION_FALLBACK,
		});

		await page.goto(await authorizationUrl(clientId, redirectUri, failedPkceVerifier, failedPkceState));
		await expect(page.getByRole("heading", {name: "Authorize MCP client"})).toBeVisible();
		const deniedCallback = await captureConsentCallback(page, redirectUri, "Cancel");
		expect(Object.fromEntries(deniedCallback.searchParams)).toStrictEqual({
			error: "access_denied",
			error_description: "User denied access",
			iss: issuer,
			state: failedPkceState,
		});

		await page.goto(await authorizationUrl(clientId, redirectUri, failedPkceVerifier, failedPkceState));
		await expect(page.getByRole("heading", {name: "Authorize MCP client"})).toBeVisible();
		const failedPkceCallback = await captureConsentCallback(page, redirectUri, "Allow");
		const failedPkceCode = authorizationCode(failedPkceCallback);
		const failedPkceResponse = await request.post(`${issuer}/oauth2/token`, {
			form: {
				client_id: clientId,
				code: failedPkceCode,
				code_verifier: `${failedPkceVerifier}-wrong`,
				grant_type: "authorization_code",
				redirect_uri: redirectUri,
				resource,
			},
		});
		expect({body: await failedPkceResponse.json(), status: failedPkceResponse.status()}).toStrictEqual({
			body: {error: "invalid_request", error_description: "code verification failed"},
			status: 401,
		});

		const secondClientId = await registerClient(request, "Second browser OAuth MCP client", secondRedirectUri);
		const secondContext = await browser.newContext({ignoreHTTPSErrors: true});
		contexts.push(secondContext);
		const secondPage = await secondContext.newPage();
		await secondPage.goto(
			await authorizationUrl(secondClientId, secondRedirectUri, secondCodeVerifier, secondOauthState),
		);
		await signInForAuthorization(secondPage);
		await expect(secondPage.getByText("Second browser OAuth MCP client")).toBeVisible();
		const secondCallback = await captureConsentCallback(secondPage, secondRedirectUri, "Allow");
		expect({
			codePresent: secondCallback.searchParams.has("code"),
			state: secondCallback.searchParams.get("state"),
		}).toStrictEqual({codePresent: true, state: secondOauthState});
		const secondCode = authorizationCode(secondCallback);
		const secondTokens = await exchangeCode(
			request,
			secondClientId,
			secondRedirectUri,
			secondCodeVerifier,
			secondCode,
		);
		const secondClient = await createProtocolClient(
			"second-browser-oauth-protocol-client",
			secondTokens.access_token,
		);
		clients.push(secondClient);
		expect(await secondClient.listTools()).toStrictEqual(expectedTools);

		await page.goto("/settings");
		await secondPage.goto("/settings");
		for (const settingsPage of [page, secondPage]) {
			await expect(settingsPage.getByText("Browser OAuth MCP client", {exact: true})).toBeVisible();
			await expect(settingsPage.getByText("Second browser OAuth MCP client", {exact: true})).toBeVisible();
		}
		await page.goto("/");
		await expect(page.getByRole("button", {name: "AFK off"})).toHaveAttribute("aria-pressed", "false");
		await page.getByRole("button", {name: "AFK off"}).click();
		await secondPage.goto("/");
		for (const deckPage of [page, secondPage]) {
			await expect(deckPage.getByRole("button", {name: "AFK on"})).toHaveAttribute("aria-pressed", "true");
		}

		const answerPromise = secondClient.callTool({
			name: "ask_yep_nope",
			arguments: {project: "OAuth browser test", questions: routedQuestions},
		});
		for (const deckPage of [page, secondPage]) {
			await expect(deckPage.getByRole("heading", {name: routedQuestions[0].title})).toBeVisible();
		}
		await secondPage.getByRole("button", {name: "Yep →"}).click();
		await expect(secondPage.getByRole("heading", {name: routedQuestions[1].title})).toBeVisible();
		await secondPage.getByRole("button", {name: "← Nope"}).click();
		await expect(secondPage.getByRole("heading", {name: routedQuestions[2].title})).toBeVisible();
		await secondPage.getByRole("button", {name: "↓ Skip"}).click();
		expect(await answerPromise).toStrictEqual({content: [{text: routedAnswer, type: "text"}]});
		for (const deckPage of [page, secondPage]) {
			await expect(deckPage.getByRole("heading", {name: "All caught up"})).toBeVisible();
		}

		const rotatedTokens = await refreshTokens(request, secondClientId, secondTokens.refresh_token);
		expect({
			accessTokenRotated: rotatedTokens.access_token !== secondTokens.access_token,
			refreshTokenRotated: rotatedTokens.refresh_token !== secondTokens.refresh_token,
			scope: rotatedTokens.scope,
			tokenType: rotatedTokens.token_type,
		}).toStrictEqual({
			accessTokenRotated: true,
			refreshTokenRotated: true,
			scope: scopes.join(" "),
			tokenType: "Bearer",
		});
		const rotatedClient = await createProtocolClient(
			"rotated-browser-oauth-protocol-client",
			rotatedTokens.access_token,
		);
		clients.push(rotatedClient);
		expect(await rotatedClient.listTools()).toStrictEqual(expectedTools);

		const abortController = new AbortController();
		const cancelledCall = rotatedClient.callTool(
			{
				name: "ask_yep_nope",
				arguments: {project: "OAuth browser cancellation", questions: [cancelledQuestion]},
			},
			undefined,
			{signal: abortController.signal},
		);
		for (const deckPage of [page, secondPage]) {
			await expect(deckPage.getByRole("heading", {name: cancelledQuestion.title})).toBeVisible();
		}
		abortController.abort();
		expect(await rejectedError(cancelledCall)).toStrictEqual({
			message: "MCP error -32001: AbortError: This operation was aborted",
			name: "McpError",
		});
		for (const deckPage of [page, secondPage]) {
			await expect(deckPage.getByRole("heading", {name: "All caught up"})).toBeVisible();
		}

		await secondPage.goto("/settings");
		const secondClientRow = secondPage
			.getByRole("listitem")
			.filter({has: secondPage.getByText("Second browser OAuth MCP client", {exact: true})});
		await secondClientRow.getByRole("button", {name: "Revoke"}).click();
		await expect(secondClientRow).toContainText("revoked");
		const revokedSecondClientError = await rejectedError(rotatedClient.listTools());
		expect(revokedSecondClientError).toStrictEqual({message: revokedAccessError, name: "Error"});
		expect(await refreshFailure(request, secondClientId, rotatedTokens.refresh_token)).toStrictEqual({
			body: {error: "invalid_grant", error_description: "invalid refresh token"},
			status: 400,
		});
		expect(await client.listTools()).toStrictEqual(expectedTools);

		const firstClientRow = secondPage
			.getByRole("listitem")
			.filter({has: secondPage.getByText("Browser OAuth MCP client", {exact: true})});
		await firstClientRow.getByRole("button", {name: "Revoke"}).click();
		await expect(firstClientRow).toContainText("revoked");
		await expect
			.poll(async () => {
				const response = await secondPage.request.get("/api/v1/afk");
				return {body: await response.json(), status: response.status()};
			})
			.toStrictEqual({body: {afk: false}, status: 200});
		const revokedFirstClientError = await rejectedError(client.listTools());
		expect(revokedFirstClientError).toStrictEqual({message: revokedAccessError, name: "Error"});
		expect(await refreshFailure(request, clientId, tokens.refresh_token)).toStrictEqual({
			body: {error: "invalid_grant", error_description: "invalid refresh token"},
			status: 400,
		});

		const recoveryClientId = await registerClient(
			request,
			"Recovery browser OAuth MCP client",
			recoveryRedirectUri,
		);
		await secondPage.getByRole("button", {name: "Sign out"}).click();
		await secondPage.goto(
			await authorizationUrl(recoveryClientId, recoveryRedirectUri, recoveryCodeVerifier, recoveryOauthState),
		);
		await expect(secondPage).toHaveURL(/\/sign-in\?.*client_id=.*sig=/);
		const signedAuthorizationQuery = new URL(secondPage.url()).searchParams.toString();
		await secondPage.getByRole("button", {name: "Forgot password?"}).click();
		expect(new URL(secondPage.url()).searchParams.toString()).toBe(signedAuthorizationQuery);
		await secondPage.getByRole("textbox", {name: "Email"}).fill(email);
		await secondPage.getByRole("button", {name: "Send recovery email"}).click();
		await expect(secondPage.getByRole("status")).toHaveText(
			"If recovery is available for that address, check its inbox for next steps.",
		);
		await secondPage.goto(await mailboxLink(request, resetSubject));
		await secondPage.getByRole("textbox", {name: "Email"}).fill(email);
		await secondPage.getByLabel("New password").fill(recoveryPassword);
		let consentSubmissions = 0;
		secondPage.on("request", (request) => {
			if (request.method() === "POST" && new URL(request.url()).pathname === "/api/auth/oauth2/consent") {
				consentSubmissions += 1;
			}
		});
		await secondPage.getByRole("button", {name: "Save new password"}).click();
		await expect(secondPage.getByRole("heading", {name: "Authorize MCP client"})).toBeVisible();
		await expect(secondPage.getByText("Recovery browser OAuth MCP client")).toBeVisible();
		const resumedParameters = new URL(secondPage.url()).searchParams;
		expect({
			clientId: resumedParameters.get("client_id"),
			consentSubmissions,
			email: resumedParameters.get("email"),
			error: resumedParameters.get("error"),
			signaturePresent: resumedParameters.has("sig"),
			token: resumedParameters.get("token"),
		}).toStrictEqual({
			clientId: recoveryClientId,
			consentSubmissions: 0,
			email: null,
			error: null,
			signaturePresent: true,
			token: null,
		});
		const recoveryCallback = await captureConsentCallback(secondPage, recoveryRedirectUri, "Cancel");
		expect({
			error: recoveryCallback.searchParams.get("error"),
			state: recoveryCallback.searchParams.get("state"),
		}).toStrictEqual({error: "access_denied", state: recoveryOauthState});
		await secondPage.goto("/settings");

		const deletion = await secondPage.evaluate(async (accountPassword) => {
			const response = await fetch("/api/auth/delete-user", {
				method: "POST",
				headers: {"Content-Type": "application/json"},
				body: JSON.stringify({password: accountPassword}),
			});
			return {body: (await response.json()) as unknown, status: response.status};
		}, recoveryPassword);
		expect(deletion).toStrictEqual({body: {message: "User deleted", success: true}, status: 200});
		let unauthorizedReconnects = 0;
		await secondPage.routeWebSocket("**/api/v1/current-deck/stream", (socket) => {
			unauthorizedReconnects += 1;
			socket.connectToServer();
		});
		await secondPage.goto("/");
		await expect(secondPage.getByRole("button", {name: "Sign in"})).toBeVisible();
		await secondPage.waitForTimeout(3_000);
		expect(unauthorizedReconnects).toBe(0);
		const deletedState = await request.post("/api/__e2e__/deleted-account", {
			data: {user_id: session.user.id},
		});
		expect({body: await deletedState.json(), status: deletedState.status()}).toStrictEqual({
			body: {cleanup_completed: 1, identity_deleted: 1, machine_tokens: 0, oauth_clients: 0, users: 0},
			status: 200,
		});
	} finally {
		await Promise.all(clients.map(async (client) => client.close().catch(() => undefined)));
		await Promise.all(contexts.map(async (context) => context.close()));
	}
});
