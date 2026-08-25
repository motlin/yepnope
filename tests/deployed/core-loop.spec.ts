import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport, StreamableHTTPError} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {isDeepStrictEqual} from "node:util";
import {expect, test, type APIRequestContext, type BrowserContext, type CDPSession, type Page} from "playwright/test";
import {z} from "zod";
import {resolveDeploymentTarget} from "../../scripts/deployment-check.ts";
import {TOOL_DESCRIPTION, TOOL_INPUT_SCHEMA} from "../../worker/ask-tool.ts";

/**
 * 🔁 The core loop, on a real deployment, with nothing substituted.
 *
 * An MCP client registers itself, is authorized over OAuth by a browser signed in to the same
 * account, and calls `ask_yep_nope`. The call blocks on Cloudflare. A browser on that account opens
 * the deck, is handed the questions over a live WebSocket, and swipes them. The blocking call
 * returns the answers the swipes produced. Every part of that is the deployed Worker, the deployed
 * Durable Object, and the deployed D1: no mailbox stub, no Siteverify stand-in, no loopback origin,
 * no `/api/__e2e__` back door — the deployment under test does not have one.
 *
 * What is deliberately not exercised here, because a robot cannot do it and weakening the gate to
 * let it would be the bug: create-account, password sign-in, emailed sign-in links, password reset,
 * and verification resend are Turnstile-gated, and finishing a registration means reading real mail.
 * A person does that once per deployment; see `scripts/deployment-check.ts`.
 */

const target = resolveDeploymentTarget(process.env);
const issuer = `${target.origin}/api/auth`;
const resource = `${target.origin}/mcp`;
const scopes = ["openid", "offline_access", "yepnope:questions"] as const;

// The deck holds every swipe before it reaches the server; see UNDO_WINDOW_MILLISECONDS in
// `src/deck.tsx`. The assertion is a lower bound, so a longer window still passes.
const UNDO_WINDOW_LOWER_BOUND_MILLISECONDS = 4_000;
const CLEANUP_TIMEOUT_MILLISECONDS = 5_000;

const runId = crypto.randomUUID().slice(0, 8);
const firstClientName = `Deployed core-loop client ${runId}`;
const secondClientName = `Deployed core-loop second client ${runId}`;
const firstRedirectUri = `http://127.0.0.1:45678/callback/deployed-${runId}`;
const secondRedirectUri = `http://127.0.0.1:45679/callback/deployed-${runId}`;

const batch = [
	{title: `Approve the deployed core-loop change? (${runId})`, body: "Exercise the real MCP Yep outcome."},
	{title: `Reject the deployed core-loop risk? (${runId})`, body: "Exercise the real MCP Nope outcome."},
	{title: `Defer the deployed core-loop option? (${runId})`, body: "Exercise the real MCP Skip outcome."},
] as const;
const batchAnswer =
	`${batch[0].title} -> YEP\n` +
	`${batch[1].title} -> NOPE\n` +
	`${batch[2].title} -> SKIPPED. The user declined to decide. ` +
	"Leave this alone and report it; do not choose for them.";

const secondClientQuestion = {
	title: `Answer the second client's question? (${runId})`,
	body: "Exercise a second authorized MCP client on the same account.",
} as const;

const retractedQuestion = {
	title: `Retract the deployed core-loop question? (${runId})`,
	body: "Exercise cancellation clearing a card from an already-open deck.",
} as const;

const expectedTools = {
	tools: [{name: "ask_yep_nope", description: TOOL_DESCRIPTION, inputSchema: TOOL_INPUT_SCHEMA}],
};

const oauthRegistrationSchema = z.object({client_id: z.string().min(1)}).loose();
const oauthTokenSchema = z
	.object({
		access_token: z.string().min(1),
		refresh_token: z.string().min(1),
		scope: z.string(),
		token_type: z.literal("Bearer"),
	})
	.loose();
const authorizationMetadataSchema = z
	.object({
		authorization_endpoint: z.url(),
		code_challenge_methods_supported: z.array(z.string()),
		issuer: z.url(),
		registration_endpoint: z.url(),
		token_endpoint: z.url(),
	})
	.loose();
const protectedResourceMetadataSchema = z
	.object({authorization_servers: z.array(z.url()), resource: z.url(), scopes_supported: z.array(z.string())})
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

// The client's loopback redirect belongs to a CLI that is not running here, so the browser's own
// request to it is answered in-process and read for the authorization code.
async function captureConsentCallback(page: Page, callback: string): Promise<URL> {
	const captured: {url: string | null} = {url: null};
	const callbackOrigin = new URL(callback).origin;
	await page.route(`${callbackOrigin}/**`, async (route) => {
		captured.url = route.request().url();
		await route.fulfill({body: "OAuth callback received", contentType: "text/plain", status: 200});
	});
	await page.getByRole("button", {name: "Allow", exact: true}).click();
	await expect.poll(() => captured.url).not.toBeNull();
	await page.unroute(`${callbackOrigin}/**`);
	if (captured.url === null) {
		throw new Error("OAuth consent returned no callback URL");
	}
	return new URL(captured.url);
}

/** Registers, authorizes, and connects one real Streamable HTTP MCP client to the deployment. */
async function authorizeClient(
	request: APIRequestContext,
	page: Page,
	name: string,
	callback: string,
): Promise<Client> {
	const clientId = await registerClient(request, name, callback);
	const verifier = `deployed-core-loop-verifier-${crypto.randomUUID()}${crypto.randomUUID()}`;
	const state = `deployed-core-loop-state-${crypto.randomUUID()}`;
	await page.goto(await authorizationUrl(clientId, callback, verifier, state));
	await expect(page.getByRole("heading", {name: "Authorize MCP client"})).toBeVisible();
	await expect(page.getByText(name)).toBeVisible();
	const callbackUrl = await captureConsentCallback(page, callback);
	expect(callbackUrl.searchParams.get("state")).toBe(state);
	const code = callbackUrl.searchParams.get("code");
	if (code === null) {
		throw new Error(`${name} was authorized but its callback carried no code`);
	}
	const tokenResponse = await request.post(`${issuer}/oauth2/token`, {
		form: {
			client_id: clientId,
			code,
			code_verifier: verifier,
			grant_type: "authorization_code",
			redirect_uri: callback,
			resource,
		},
	});
	expect(tokenResponse.status()).toBe(200);
	const tokens = oauthTokenSchema.parse(await tokenResponse.json());
	expect({scope: tokens.scope, tokenType: tokens.token_type}).toStrictEqual({
		scope: scopes.join(" "),
		tokenType: "Bearer",
	});
	const transport = new StreamableHTTPClientTransport(new URL(resource), {
		fetch: async (input, init) => {
			const method = init?.method ?? (input instanceof Request ? input.method : "GET");
			process.stderr.write(`[deployed core loop] MCP ${method} ${resource}\n`);
			const response = await fetch(input, init);
			process.stderr.write(
				`[deployed core loop] MCP ${method} ${resource} -> ${String(response.status)} ${response.headers.get("content-type") ?? "without content type"}\n`,
			);
			return response;
		},
		requestInit: {headers: {Authorization: `Bearer ${tokens.access_token}`}},
	});
	const client = new Client({name, version: "1.0.0"});
	client.onerror = (error) => {
		process.stderr.write(`[deployed core loop] ${name} MCP error: ${error.message}\n`);
	};
	try {
		await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
	} catch (error) {
		if (error instanceof StreamableHTTPError) {
			throw new Error(`${name} failed to initialize with status ${String(error.code)}`);
		}
		throw error;
	}
	return client;
}

/**
 * Signs a browser in with the enrolled automation passkey. Chrome's virtual authenticator holds the
 * private key; the deployment runs the real WebAuthn verification against the public key it recorded
 * when a person enrolled this credential.
 */
async function signInWithAutomationPasskey(context: BrowserContext): Promise<Page> {
	const page = await context.newPage();
	const cdp: CDPSession = await context.newCDPSession(page);
	await cdp.send("WebAuthn.enable");
	const {authenticatorId} = await cdp.send("WebAuthn.addVirtualAuthenticator", {
		options: {
			automaticPresenceSimulation: true,
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			protocol: "ctap2",
			transport: "internal",
		},
	});
	await cdp.send("WebAuthn.addCredential", {
		authenticatorId,
		credential: {
			credentialId: target.passkey.credentialId,
			isResidentCredential: true,
			privateKey: target.passkey.privateKey,
			rpId: target.passkey.rpId,
			// 🔢 WebAuthn's clone detection refuses an assertion whose counter does not exceed the one
			// the deployment stored, and the deployment raises that stored counter on every sign-in.
			// The enrolled `signCount` is therefore stale the moment it is first used — replaying it
			// would authenticate once and refuse forever after. Seconds since the epoch is monotonic
			// across runs, so each sign-in presents a counter comfortably above the last.
			signCount: Math.floor(Date.now() / 1000),
			userHandle: target.passkey.userHandle,
		},
	});
	await page.goto("/sign-in");
	await page.getByRole("button", {name: "Sign in with a passkey"}).click();
	await expect(page).toHaveURL(/\/settings$/);
	return page;
}

async function rejectedError(promise: Promise<unknown>): Promise<{message: string; name: string}> {
	const outcome = await promise.then(
		() => ({error: null}),
		(error: unknown) => ({error}),
	);
	if (!(outcome.error instanceof Error)) {
		throw new Error("Expected the cancelled tool call to reject with an Error");
	}
	return {message: outcome.error.message, name: outcome.error.name};
}

/** Tracks a blocking tool call so the test can assert it is still blocking. */
function settlementTracker<Result>(call: Promise<Result>): {promise: Promise<Result>; settled: () => boolean} {
	let settled = false;
	const promise = call.finally(() => {
		settled = true;
	});
	return {promise, settled: () => settled};
}

async function revokeClient(page: Page, name: string): Promise<void> {
	const row = page.getByRole("listitem").filter({has: page.getByText(name, {exact: true})});
	if ((await row.count()) === 0) {
		return;
	}
	await row.getByRole("button", {name: "Revoke"}).click({timeout: CLEANUP_TIMEOUT_MILLISECONDS});
	await expect(row).toContainText("revoked", {timeout: CLEANUP_TIMEOUT_MILLISECONDS});
}

async function deploymentStep<Result>(name: string, body: () => Promise<Result>): Promise<Result> {
	process.stderr.write(`[deployed core loop] ${name}\n`);
	const result = await test.step(name, body);
	process.stderr.write(`[deployed core loop] ${name} complete\n`);
	return result;
}

test("a deployed YepNope answers an authorized MCP client's blocking question from the deck", async ({
	browser,
	request,
}) => {
	const clients: Client[] = [];
	let context: BrowserContext | null = null;
	let settingsPage: Page | null = null;
	try {
		await deploymentStep("validate OAuth discovery metadata", async () => {
			const [authorizationMetadataResponse, protectedResourceMetadataResponse] = await Promise.all([
				request.get(`${target.origin}/.well-known/oauth-authorization-server/api/auth`),
				request.get(`${target.origin}/.well-known/oauth-protected-resource/mcp`),
			]);
			const authorizationMetadata = authorizationMetadataSchema.parse(await authorizationMetadataResponse.json());
			const protectedResourceMetadata = protectedResourceMetadataSchema.parse(
				await protectedResourceMetadataResponse.json(),
			);
			expect({
				authorizationEndpoint: authorizationMetadata.authorization_endpoint,
				authorizationServers: protectedResourceMetadata.authorization_servers,
				codeChallengeMethods: authorizationMetadata.code_challenge_methods_supported,
				issuer: authorizationMetadata.issuer,
				registrationEndpoint: authorizationMetadata.registration_endpoint,
				resource: protectedResourceMetadata.resource,
				scopesSupported: protectedResourceMetadata.scopes_supported,
				tokenEndpoint: authorizationMetadata.token_endpoint,
			}).toStrictEqual({
				authorizationEndpoint: `${issuer}/oauth2/authorize`,
				authorizationServers: [issuer],
				codeChallengeMethods: ["S256"],
				issuer,
				registrationEndpoint: `${issuer}/oauth2/register`,
				resource,
				scopesSupported: ["yepnope:questions"],
				tokenEndpoint: `${issuer}/oauth2/token`,
			});
		});

		const signedInSettingsPage = await deploymentStep("sign in with the deployment passkey", async () => {
			context = await browser.newContext();
			return signInWithAutomationPasskey(context);
		});
		settingsPage = signedInSettingsPage;

		const firstClient = await deploymentStep("authorize and connect the first MCP client", async () =>
			authorizeClient(request, signedInSettingsPage, firstClientName, firstRedirectUri),
		);
		clients.push(firstClient);
		await deploymentStep("list tools on the first MCP client", async () => {
			const tools = await firstClient.listTools();
			if (!isDeepStrictEqual(tools, expectedTools)) {
				throw new Error("the deployment's MCP tool contract does not match this checkout");
			}
		});

		// 📱 Routing to the deck is the account's own switch, and the deployment starts wherever the
		// last run left it, so this asserts the state it puts the account into rather than the one
		// it found.
		const deckPage = await deploymentStep("open the deck and enable AFK routing", async () => {
			if (context === null) {
				throw new Error("the browser context was not created during passkey sign-in");
			}
			const page = await context.newPage();
			await page.goto("/");
			const afkToggle = page.getByRole("button", {name: /^AFK (on|off)$/});
			await expect(afkToggle).toBeEnabled();
			if ((await afkToggle.getAttribute("aria-pressed")) !== "true") {
				await afkToggle.click();
			}
			await expect(afkToggle).toHaveAttribute("aria-pressed", "true");
			await expect
				.poll(async () => {
					const response = await page.request.get(`${target.origin}/api/v1/afk`);
					return {body: await response.json(), status: response.status()};
				})
				.toStrictEqual({body: {afk: true}, status: 200});
			return page;
		});

		await deploymentStep("answer the first MCP client's three-question batch", async () => {
			const batchCall = settlementTracker(
				firstClient.callTool({
					name: "ask_yep_nope",
					arguments: {project: `Deployed core loop ${runId}`, questions: batch},
				}),
			);
			await expect(deckPage.getByRole("heading", {name: batch[0].title})).toBeVisible();
			await deckPage.getByRole("button", {name: "Yep →"}).click();
			await expect(deckPage.getByRole("heading", {name: batch[1].title})).toBeVisible();
			await deckPage.getByRole("button", {name: "← Nope"}).click();
			await expect(deckPage.getByRole("heading", {name: batch[2].title})).toBeVisible();
			await deckPage.getByRole("button", {name: "↓ Skip"}).click();
			const lastSwipeAt = Date.now();

			// ↩️ The last swipe of a batch waits out the undo window like every other one, so the call
			// is still blocking while the deck offers to take the swipe back.
			await expect(deckPage.getByRole("button", {name: "Undo skip"})).toBeVisible();
			expect(batchCall.settled()).toBe(false);
			expect(await batchCall.promise).toStrictEqual({content: [{text: batchAnswer, type: "text"}]});
			expect(Date.now() - lastSwipeAt).toBeGreaterThanOrEqual(UNDO_WINDOW_LOWER_BOUND_MILLISECONDS);
			await expect(deckPage.getByRole("heading", {name: "All caught up"})).toBeVisible();
		});

		// 🔗 A second authorized client on the same account, answered from a deck that was already
		// open before the question existed.
		const secondClient = await deploymentStep("authorize and connect the second MCP client", async () =>
			authorizeClient(request, signedInSettingsPage, secondClientName, secondRedirectUri),
		);
		clients.push(secondClient);
		await deploymentStep("answer the second MCP client's question", async () => {
			await signedInSettingsPage.goto("/settings");
			for (const name of [firstClientName, secondClientName]) {
				await expect(signedInSettingsPage.getByText(name, {exact: true})).toBeVisible();
			}
			const secondCall = settlementTracker(
				secondClient.callTool({
					name: "ask_yep_nope",
					arguments: {project: `Deployed core loop ${runId}`, questions: [secondClientQuestion]},
				}),
			);
			await expect(deckPage.getByRole("heading", {name: secondClientQuestion.title})).toBeVisible();
			await deckPage.getByRole("button", {name: "Yep →"}).click();
			expect(await secondCall.promise).toStrictEqual({
				content: [{text: `${secondClientQuestion.title} -> YEP`, type: "text"}],
			});
		});

		// 🚫 A retraction has to reach a deck that is already showing the card, which is the live
		// socket's job and nothing else's.
		await deploymentStep("retract the first MCP client's live question", async () => {
			const abortController = new AbortController();
			const retractedCall = firstClient.callTool(
				{
					name: "ask_yep_nope",
					arguments: {project: `Deployed core loop ${runId}`, questions: [retractedQuestion]},
				},
				undefined,
				{signal: abortController.signal},
			);
			await expect(deckPage.getByRole("heading", {name: retractedQuestion.title})).toBeVisible();
			abortController.abort();
			expect((await rejectedError(retractedCall)).name).toBe("McpError");
			await expect(deckPage.getByRole("heading", {name: "All caught up"})).toBeVisible();
		});
	} finally {
		process.stderr.write("[deployed core loop] close MCP clients\n");
		await Promise.all(clients.map(async (client) => client.close().catch(() => undefined)));
		process.stderr.write("[deployed core loop] close MCP clients complete\n");
		if (settingsPage !== null) {
			// 🧹 The account outlives the run, so it goes back to the state the run found it in: no
			// client this run registered still authorized, and routing off. Revoking the last
			// authorized client turns routing off by itself, so the toggle here is only for the
			// runs where a revocation did not land.
			process.stderr.write("[deployed core loop] open settings for cleanup\n");
			await settingsPage.goto("/settings", {timeout: CLEANUP_TIMEOUT_MILLISECONDS}).catch(() => undefined);
			process.stderr.write("[deployed core loop] open settings for cleanup complete\n");
			for (const name of [firstClientName, secondClientName]) {
				process.stderr.write(`[deployed core loop] revoke ${name}\n`);
				await revokeClient(settingsPage, name).catch(() => undefined);
				process.stderr.write(`[deployed core loop] revoke ${name} complete\n`);
			}
			process.stderr.write("[deployed core loop] disable AFK routing\n");
			await settingsPage.goto("/", {timeout: CLEANUP_TIMEOUT_MILLISECONDS}).catch(() => undefined);
			const routing = settingsPage.getByRole("button", {name: /^AFK (on|off)$/});
			if ((await routing.getAttribute("aria-pressed").catch(() => null)) === "true") {
				await routing.click({timeout: CLEANUP_TIMEOUT_MILLISECONDS}).catch(() => undefined);
			}
			process.stderr.write("[deployed core loop] disable AFK routing complete\n");
		}
		// The browser fixture owns its contexts. Closing one here after the test timeout can hang in
		// Playwright teardown and replace the named stage that identified the original failure.
	}
});
