import {expect, test, type APIRequestContext, type Locator, type Page} from "playwright/test";
import {z} from "zod";
import {mailboxLink} from "./helpers";

// 📟 The Claude Code permission hook is a local shell command: no browser, no callback port, and no
// way to speak MCP. It holds its own credential, obtained through RFC 8628, and the account holder
// has to be able to take that credential away from Settings without waiting for it to expire.

const serverOrigin = "https://localhost:4173";
const issuer = `${serverOrigin}/api/auth`;
const resource = `${serverOrigin}/mcp`;
const deviceCodeGrantType = "urn:ietf:params:oauth:grant-type:device_code";
const email = "alice-device-browser@example.com";
const password = "device-browser-password";
const verificationSubject = "Verify your YepNope email";
const scopes = ["openid", "offline_access", "yepnope:questions"] as const;
const hookClientName = "Claude Code permission hook";
const strangerClientName = "Unrecognized laptop hook";
// The user-code alphabet drops the characters a person misreads off a terminal.
const userCodeShape = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const pollingIntervalMilliseconds = 5_000;
// Revocation only proves anything while the token it kills still has most of its life left.
const freshAccessTokenMarginSeconds = 300;

const registrationSchema = z.object({client_id: z.string().min(1)}).loose();
const deviceCodeSchema = z
	.object({
		device_code: z.string().min(1),
		expires_in: z.number(),
		interval: z.number(),
		user_code: z.string(),
		verification_uri: z.string(),
		verification_uri_complete: z.string(),
	})
	.loose();
const deviceTokenSchema = z
	.object({
		access_token: z.string().min(1),
		expires_in: z.number(),
		refresh_token: z.string().min(1),
		scope: z.string(),
		token_type: z.literal("Bearer"),
	})
	.loose();

interface EndpointResult {
	body: unknown;
	status: number;
}

/**
 * 🚫 A device client registers without `redirect_uris` and without `response_types`, because it has
 * nowhere to be redirected to; asking for either is what gets a registration refused.
 */
async function registerDeviceClient(request: APIRequestContext, name: string): Promise<string> {
	const response = await request.post(`${issuer}/oauth2/register`, {
		data: {
			client_name: name,
			grant_types: [deviceCodeGrantType, "refresh_token"],
			resources: [resource],
			scope: scopes.join(" "),
			token_endpoint_auth_method: "none",
		},
	});
	expect(response.status()).toBe(201);
	return registrationSchema.parse(await response.json()).client_id;
}

async function requestDeviceCode(
	request: APIRequestContext,
	clientId: string,
): Promise<z.infer<typeof deviceCodeSchema>> {
	const response = await request.post(`${issuer}/device/code`, {
		form: {client_id: clientId, resource, scope: scopes.join(" ")},
	});
	expect(response.status()).toBe(200);
	return deviceCodeSchema.parse(await response.json());
}

/** One turn of the polling loop the hook's login command runs while a person reads the code. */
async function pollForToken(request: APIRequestContext, clientId: string, deviceCode: string): Promise<EndpointResult> {
	const response = await request.post(`${issuer}/oauth2/token`, {
		form: {
			client_id: clientId,
			device_code: deviceCode,
			grant_type: deviceCodeGrantType,
			resource,
		},
	});
	return {body: await response.json(), status: response.status()};
}

/** ⏳ The five-second floor is enforced, not advisory: polling under it answers `slow_down`. */
async function waitOutPollingInterval(page: Page, lastPolledAt: number): Promise<void> {
	await page.waitForTimeout(Math.max(0, pollingIntervalMilliseconds - (Date.now() - lastPolledAt)));
}

/** The hook speaks plain HTTP with its bearer token; 401 carries no body at all. */
async function callHook(request: APIRequestContext, accessToken: string): Promise<{body: string; status: number}> {
	const response = await request.post("/api/v1/hook", {
		data: {hook_event_name: "PreToolUse", tool_input: {}, tool_name: "Read"},
		headers: {Authorization: `Bearer ${accessToken}`},
	});
	return {body: await response.text(), status: response.status()};
}

/** The first two fields of a connected-client row are locale timestamps; the rest is the contract. */
async function connectedClientSummary(row: Locator): Promise<{grantedScopes: string; status: string}> {
	const fields = ((await row.locator("small").textContent()) ?? "").split(" · ");
	return {grantedScopes: fields.at(-2) ?? "", status: fields.at(-1) ?? ""};
}

test("a device-authorized hook is approved in the browser and dies the moment Settings revokes it", async ({
	browser,
	request,
}) => {
	const context = await browser.newContext({ignoreHTTPSErrors: true});
	try {
		const page = await context.newPage();
		const clientId = await registerDeviceClient(request, hookClientName);
		const issued = await requestDeviceCode(request, clientId);
		expect({
			expiresIn: issued.expires_in,
			interval: issued.interval,
			userCodeShape: userCodeShape.test(issued.user_code),
			verificationUri: issued.verification_uri,
			verificationUriComplete: issued.verification_uri_complete,
		}).toStrictEqual({
			expiresIn: 600,
			interval: 5,
			userCodeShape: true,
			verificationUri: `${serverOrigin}/device`,
			verificationUriComplete: `${serverOrigin}/device?user_code=${issued.user_code}`,
		});

		const pending = await pollForToken(request, clientId, issued.device_code);
		const tooSoon = await pollForToken(request, clientId, issued.device_code);
		const lastPolledAt = Date.now();
		expect({pending, tooSoon}).toStrictEqual({
			pending: {
				body: {error: "authorization_pending", error_description: "Authorization pending"},
				status: 400,
			},
			tooSoon: {body: {error: "slow_down", error_description: "Polling too frequently"}, status: 400},
		});

		await page.goto("/register");
		await page.getByRole("textbox", {name: "Email"}).fill(email);
		await page.getByLabel("Password").fill(password);
		await page.getByRole("button", {name: "Create account"}).click();
		await expect(page.getByRole("heading", {name: "Verify your email"})).toBeVisible();
		await page.goto(await mailboxLink(request, verificationSubject, email));
		await expect(page.getByRole("button", {name: "Connect Claude Code or Codex"})).toBeVisible();

		await page.goto(issued.verification_uri_complete);
		await expect(page.getByRole("button", {name: "Approve"})).toBeVisible();
		expect({
			capabilityDescriptions: await page.locator(".oauth-capabilities li span").allTextContents(),
			capabilityLabels: await page.locator(".oauth-capabilities li strong").allTextContents(),
			prompt: await page.locator(".account-panel p").first().textContent(),
			title: await page.locator(".account-panel h1").textContent(),
		}).toStrictEqual({
			capabilityDescriptions: [
				"Refresh this connection without asking you to sign in each time.",
				"Confirm which verified YepNope account is authorizing the connection.",
				"Send questions to YepNope and wait for your Yep, Nope, or Skip answer.",
			],
			capabilityLabels: ["Stay connected", "Use your YepNope identity", "Ask questions"],
			prompt: `${hookClientName} printed code ${issued.user_code} and is waiting for this account to answer.`,
			title: "Approve a device",
		});

		await page.getByRole("button", {name: "Approve"}).click();
		await expect(page.getByRole("heading", {name: "Device approved"})).toBeVisible();
		expect({
			detail: await page.locator(".oauth-handoff span").textContent(),
			headline: await page.locator(".oauth-handoff strong").textContent(),
		}).toStrictEqual({
			detail: "You can revoke it any time under Settings, Connected MCP clients.",
			headline: "Approved. You can go back to your terminal.",
		});

		await waitOutPollingInterval(page, lastPolledAt);
		const granted = await pollForToken(request, clientId, issued.device_code);
		const accessTokenIssuedAt = Date.now();
		const tokens = deviceTokenSchema.parse(granted.body);
		expect({
			expiresIn: tokens.expires_in,
			fields: Object.keys(tokens).sort(),
			scope: tokens.scope,
			status: granted.status,
			tokenType: tokens.token_type,
		}).toStrictEqual({
			expiresIn: 600,
			fields: ["access_token", "expires_at", "expires_in", "id_token", "refresh_token", "scope", "token_type"],
			scope: scopes.join(" "),
			status: 200,
			tokenType: "Bearer",
		});

		const authorizedHook = await callHook(request, tokens.access_token);
		await page.goto("/settings");
		const hookRow = page.getByRole("listitem").filter({hasText: hookClientName});
		await expect(hookRow).toBeVisible();
		expect({
			authorizedHook,
			connectedClients: await page.locator(".connected-clients .device-list li strong").allTextContents(),
			summary: await connectedClientSummary(hookRow),
		}).toStrictEqual({
			authorizedHook: {body: "{}", status: 200},
			connectedClients: [hookClientName],
			summary: {
				grantedScopes:
					"Granted scopes: Stay connected (offline_access), " +
					"Use your YepNope identity (openid), Ask questions (yepnope:questions)",
				status: "active",
			},
		});

		// 🙅 A second machine asks, and this account says no: the deny path must never mint a token.
		const strangerClientId = await registerDeviceClient(request, strangerClientName);
		const strangerCode = await requestDeviceCode(request, strangerClientId);
		await page.goto(strangerCode.verification_uri_complete);
		await expect(page.getByRole("button", {name: "Deny"})).toBeVisible();
		await page.getByRole("button", {name: "Deny"}).click();
		await expect(page.getByRole("heading", {name: "Device denied"})).toBeVisible();
		const deniedDetail = await page.locator(".oauth-handoff span").textContent();
		const deniedHeadline = await page.locator(".oauth-handoff strong").textContent();
		const refused = await pollForToken(request, strangerClientId, strangerCode.device_code);
		await page.goto("/settings");
		await expect(hookRow).toBeVisible();
		expect({
			connectedClients: await page.locator(".connected-clients .device-list li strong").allTextContents(),
			deniedDetail,
			deniedHeadline,
			refused,
		}).toStrictEqual({
			connectedClients: [hookClientName],
			deniedDetail: "You can close this tab and go back to your terminal.",
			deniedHeadline: "Denied. Nothing was connected to your account.",
			refused: {body: {error: "access_denied", error_description: "Access denied"}, status: 400},
		});

		await hookRow.getByRole("button", {name: "Revoke"}).click();
		await expect(hookRow).toContainText("revoked");
		const revokedHook = await callHook(request, tokens.access_token);
		const accessTokenAgeSeconds = (Date.now() - accessTokenIssuedAt) / 1_000;
		// 🔌 The whole point: the very next hook call fails on revocation, not on expiry. The token the
		// hook is still holding has minutes of its ten-minute lifetime left, and it is already dead.
		expect({
			accessTokenLifetimeSeconds: tokens.expires_in,
			accessTokenStillFreshAtRevocation:
				tokens.expires_in - accessTokenAgeSeconds > freshAccessTokenMarginSeconds,
			revokedHook,
			summary: await connectedClientSummary(hookRow),
		}).toStrictEqual({
			accessTokenLifetimeSeconds: 600,
			accessTokenStillFreshAtRevocation: true,
			revokedHook: {body: "", status: 401},
			summary: {
				grantedScopes:
					"Granted scopes: Stay connected (offline_access), " +
					"Use your YepNope identity (openid), Ask questions (yepnope:questions)",
				status: "revoked",
			},
		});
	} finally {
		await context.close();
	}
});
