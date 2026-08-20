import {resolve} from "node:path";
import {expect, test, type Page} from "playwright/test";
import {fulfillJson} from "./helpers";

const screenshotDirectory = resolve(import.meta.dirname, "../../.llm/screenshots");
const clientName = "Codex";
const oauthQuery = new URLSearchParams({
	client_id: "codex-mcp-client",
	resource: "https://localhost:4173/mcp",
	scope: "openid offline_access yepnope:questions",
	sig: "signed-authorization-request",
}).toString();

/**
 * Codex registers an ephemeral loopback redirect shaped `http://127.0.0.1:<port>/callback/<suffix>`
 * and answers it from its own `tiny-http` server with `text/plain`. The consent page and the handoff
 * panel are therefore the last two surfaces YepNope owns in the flow, and both are covered here.
 */
const loopbackCallback = "http://127.0.0.1:57015/callback/4FAwZNJbSB0T?code=test-code&state=test-state";

interface ConsentHarness {
	consentSubmissions: unknown[];
	requestedCallbacks: string[];
}

async function openConsent(page: Page): Promise<ConsentHarness> {
	const harness: ConsentHarness = {consentSubmissions: [], requestedCallbacks: []};
	await page.route("**/api/auth/get-session", async (route) =>
		fulfillJson(route, {user: {email: "alice@example.com", emailVerified: true, id: "user-alice"}}),
	);
	await page.route("**/api/v1/afk", async (route) => fulfillJson(route, {afk: false}));
	await page.routeWebSocket("**/api/v1/current-deck/stream", (socket) => {
		socket.send(
			JSON.stringify({afk: false, connected_mcp_client_count: 0, current_deck: [], type: "current_deck"}),
		);
	});
	await page.route("**/api/auth/oauth2/public-client**", async (route) =>
		fulfillJson(route, {client_id: "codex-mcp-client", client_name: clientName}),
	);
	await page.route("**/api/auth/oauth2/consent", async (route) => {
		harness.consentSubmissions.push(route.request().postDataJSON());
		await fulfillJson(route, {redirect: true, url: loopbackCallback});
	});
	// The real callback is answered by the client's own loopback server, which replaces this document
	// with its plain-text page. Answering 204 records the exact requested callback while leaving the
	// handoff on screen, so the surface YepNope owns can be asserted and photographed.
	await page.route("http://127.0.0.1:57015/**", async (route) => {
		harness.requestedCallbacks.push(route.request().url());
		await route.fulfill({status: 204});
	});
	await page.goto(`/oauth/consent?${oauthQuery}`);
	await expect(page.getByRole("heading", {name: "Authorize MCP client"})).toBeVisible();
	await expect(page.getByRole("button", {name: "Allow", exact: true})).toBeVisible();
	return harness;
}

async function readPanel(page: Page): Promise<unknown> {
	return page.locator(".account-panel").evaluate((panel) => ({
		buttons: [...panel.querySelectorAll("button")].map((button) => button.textContent),
		capabilities: [...panel.querySelectorAll(".oauth-capabilities li strong")].map(
			(capability) => capability.textContent,
		),
		handoff: [...panel.querySelectorAll("[role='status']")].map((status) => status.textContent),
		headings: [...panel.querySelectorAll("h1")].map((heading) => heading.textContent),
	}));
}

async function assertNoApplicationChrome(page: Page): Promise<void> {
	expect(
		await page.locator("body").evaluate((body) => ({
			afks: body.querySelectorAll(".afk-toggle, .account-status").length,
			appHeaders: body.querySelectorAll(".app-header").length,
			deckHeaders: body.querySelectorAll(".deck-header").length,
			settingsControls: body.querySelectorAll(".settings-button").length,
		})),
	).toStrictEqual({afks: 0, appHeaders: 0, deckHeaders: 0, settingsControls: 0});
}

async function allowAndReachHandoff(page: Page): Promise<void> {
	await page.getByRole("button", {name: "Allow", exact: true}).click();
	await expect(page.getByRole("heading", {name: "Connection authorized"})).toBeVisible();
}

test("the authorization and handoff surfaces read cleanly on a desktop window", async ({browser}) => {
	const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {height: 900, width: 1440}});
	const page = await context.newPage();
	try {
		const harness = await openConsent(page);
		expect(await readPanel(page)).toStrictEqual({
			buttons: ["Allow", "Cancel"],
			capabilities: ["Use your YepNope identity", "Stay connected", "Ask questions"],
			handoff: [],
			headings: ["Authorize MCP client"],
		});
		await assertNoApplicationChrome(page);
		await page.screenshot({fullPage: true, path: resolve(screenshotDirectory, "oauth-consent-desktop.png")});

		await allowAndReachHandoff(page);
		expect(await readPanel(page)).toStrictEqual({
			buttons: [],
			capabilities: [],
			handoff: [
				"YepNope sent your approval back to Codex." +
					"You can close this tab once Codex confirms the connection in your terminal.",
			],
			headings: ["Connection authorized"],
		});
		await assertNoApplicationChrome(page);
		await page.screenshot({fullPage: true, path: resolve(screenshotDirectory, "oauth-handoff-desktop.png")});

		expect({
			consentSubmissions: harness.consentSubmissions,
			requestedCallbacks: harness.requestedCallbacks,
		}).toStrictEqual({
			consentSubmissions: [{accept: true, oauth_query: oauthQuery}],
			requestedCallbacks: [loopbackCallback],
		});
	} finally {
		await context.close();
	}
});

test("the authorization and handoff surfaces fit a narrow phone window", async ({browser}) => {
	const context = await browser.newContext({
		ignoreHTTPSErrors: true,
		isMobile: true,
		viewport: {height: 568, width: 320},
	});
	const page = await context.newPage();
	try {
		const harness = await openConsent(page);
		await page.screenshot({fullPage: true, path: resolve(screenshotDirectory, "oauth-consent-narrow-mobile.png")});

		await allowAndReachHandoff(page);
		const panelBounds = await page.locator(".account-panel").boundingBox();
		const handoffBounds = await page.locator(".oauth-handoff").boundingBox();
		if (panelBounds === null || handoffBounds === null) {
			throw new Error("handoff layout bounds are missing");
		}
		expect({
			handoffOverflows: handoffBounds.x + handoffBounds.width > panelBounds.x + panelBounds.width,
			horizontalScroll: await page.evaluate(
				() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
			),
			panelWidth: panelBounds.width,
			panelX: panelBounds.x,
		}).toStrictEqual({handoffOverflows: false, horizontalScroll: false, panelWidth: 288, panelX: 16});
		await page.screenshot({fullPage: true, path: resolve(screenshotDirectory, "oauth-handoff-narrow-mobile.png")});
		expect(harness.requestedCallbacks).toStrictEqual([loopbackCallback]);
	} finally {
		await context.close();
	}
});
