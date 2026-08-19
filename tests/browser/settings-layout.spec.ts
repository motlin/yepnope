import {resolve} from "node:path";
import {expect, test, type Page, type Route} from "playwright/test";

const screenshotDirectory = resolve(import.meta.dirname, "../../.llm/screenshots");

async function fulfillJson(route: Route, body: unknown): Promise<void> {
	await route.fulfill({json: body});
}

async function routeSettingsData(page: Page): Promise<void> {
	await page.route("**/api/auth/get-session", async (route) =>
		fulfillJson(route, {
			user: {id: "user-alice", email: "alice@example.com", emailVerified: true},
		}),
	);
	await page.route("**/api/v1/afk", async (route) => fulfillJson(route, {afk: false}));
	await page.route("**/api/v1/pair/status", async (route) =>
		fulfillJson(route, {machine_count: 1, paired: true, pending_pairing_expires_at: null}),
	);
	await page.route("**/api/v1/account/devices", async (route) =>
		fulfillJson(route, {
			connected_mcp_clients: [
				{
					id: "connected-mcp-client-management-id",
					display_name: "Alice laptop",
					authorized_at: 946_684_800_000,
					last_used_at: null,
					granted_scopes: ["yepnope:questions", "yepnope:afk"],
					status: "active",
					revoked_at: null,
				},
			],
			push_devices: [{id: "push-alice", label: "Alice phone", created_at: 946_684_800_000}],
		}),
	);
	await page.routeWebSocket("**/api/v1/current-deck/stream", (socket) => {
		socket.send(
			JSON.stringify({
				type: "current_deck",
				afk: false,
				connected_mcp_client_count: 1,
				current_deck: [],
			}),
		);
	});
}

async function routePairingCode(page: Page): Promise<void> {
	await page.route("**/api/v1/pair/code", async (route) =>
		fulfillJson(route, {
			code: "ABC234",
			expires_at: 2_000_000_000_000,
			pairing: {machine_count: 1, paired: true, pending_pairing_expires_at: 2_000_000_000_000},
		}),
	);
}

async function openSettings(page: Page): Promise<void> {
	await routeSettingsData(page);
	await page.goto("/settings");
	await expect(page.getByRole("heading", {name: "Privacy and retention"})).toBeVisible();
	await expect(page.getByRole("button", {name: "Back to the deck"})).toBeVisible();
}

async function generatePairingCode(page: Page): Promise<void> {
	await routePairingCode(page);
	await openSettings(page);
	await page.getByRole("button", {name: "Generate and copy pairing code"}).click();
	await expect(page.locator("code.pairing-code")).toHaveText("ABC234");
}

async function assertViewportScrollsSettings(page: Page): Promise<void> {
	const settings = page.locator(".settings");
	const privacy = page.getByRole("heading", {name: "Privacy and retention"}).locator("xpath=..");
	const back = page.getByRole("button", {name: "Back to the deck"});

	const initialGeometry = await settings.evaluate((element) => ({
		clientHeight: element.clientHeight,
		overflowY: getComputedStyle(element).overflowY,
		scrollHeight: element.scrollHeight,
		scrollTop: element.scrollTop,
		viewportScrollHeight: document.documentElement.scrollHeight,
		viewportHeight: document.documentElement.clientHeight,
	}));
	expect(initialGeometry.clientHeight).toBe(initialGeometry.scrollHeight);
	expect(initialGeometry.overflowY).toBe("visible");
	expect(initialGeometry.scrollTop).toBe(0);
	expect(initialGeometry.viewportScrollHeight).toBeGreaterThan(initialGeometry.viewportHeight);

	await back.scrollIntoViewIfNeeded();
	const scrolledGeometry = await page.evaluate(() => {
		const settingsElement = document.querySelector<HTMLElement>(".settings");
		const privacyElement = document.querySelector<HTMLElement>(".settings .hint:nth-last-of-type(1)");
		const backElement = document.querySelector<HTMLElement>(".settings .back");
		if (settingsElement === null || privacyElement === null || backElement === null) {
			throw new Error("settings controls are missing");
		}
		const privacyBounds = privacyElement.getBoundingClientRect();
		const backBounds = backElement.getBoundingClientRect();
		return {
			backBottom: backBounds.bottom,
			backLeft: backBounds.left,
			backRight: backBounds.right,
			privacyBottom: privacyBounds.bottom,
			privacyLeft: privacyBounds.left,
			privacyRight: privacyBounds.right,
			privacyTop: privacyBounds.top,
			settingsLeft: settingsElement.getBoundingClientRect().left,
			settingsRight: settingsElement.getBoundingClientRect().right,
			settingsScrollTop: settingsElement.scrollTop,
			viewportHeight: window.innerHeight,
			viewportScrollTop: document.scrollingElement?.scrollTop ?? 0,
		};
	});
	expect(scrolledGeometry.settingsScrollTop).toBe(0);
	expect(scrolledGeometry.viewportScrollTop).toBeGreaterThan(0);
	expect(scrolledGeometry.privacyTop).toBeGreaterThanOrEqual(0);
	expect(scrolledGeometry.privacyBottom).toBeLessThanOrEqual(scrolledGeometry.viewportHeight);
	expect(scrolledGeometry.backBottom).toBeLessThanOrEqual(scrolledGeometry.viewportHeight);
	expect(scrolledGeometry.privacyLeft).toBeGreaterThanOrEqual(scrolledGeometry.settingsLeft);
	expect(scrolledGeometry.privacyRight).toBeLessThanOrEqual(scrolledGeometry.settingsRight);
	expect(scrolledGeometry.backLeft).toBeGreaterThanOrEqual(scrolledGeometry.settingsLeft);
	expect(scrolledGeometry.backRight).toBeLessThanOrEqual(scrolledGeometry.settingsRight);

	await expect(privacy).toBeVisible();
	await expect(back).toBeVisible();
}

test("settings uses a bounded desktop container and the viewport scrollbar", async ({browser}) => {
	const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {height: 768, width: 1440}});
	const page = await context.newPage();
	try {
		await openSettings(page);
		const applicationBounds = await page.locator(".app").boundingBox();
		if (applicationBounds === null) {
			throw new Error("application bounds are missing");
		}
		expect(applicationBounds.width).toBe(880);
		expect(applicationBounds.x).toBe(280);
		expect(applicationBounds.y).toBe(0);
		expect(applicationBounds.height).toBeGreaterThan(768);
		await assertViewportScrollsSettings(page);
		await page.evaluate(() => {
			window.scrollTo(0, 0);
		});
		await page.screenshot({fullPage: true, path: resolve(screenshotDirectory, "settings-desktop.png")});
	} finally {
		await context.close();
	}
});

test("settings keeps phone-width padding and full-page scrolling", async ({browser}) => {
	const context = await browser.newContext({
		ignoreHTTPSErrors: true,
		isMobile: true,
		viewport: {height: 844, width: 390},
	});
	const page = await context.newPage();
	try {
		await openSettings(page);
		const applicationBounds = await page.locator(".app").boundingBox();
		const settingsBounds = await page.locator(".settings").boundingBox();
		if (applicationBounds === null || settingsBounds === null) {
			throw new Error("responsive settings bounds are missing");
		}
		expect(applicationBounds.width).toBe(390);
		expect(applicationBounds.x).toBe(0);
		expect(applicationBounds.y).toBe(0);
		expect(applicationBounds.height).toBeGreaterThanOrEqual(844);
		expect(settingsBounds.width).toBe(358);
		expect(settingsBounds.x).toBe(16);
		await assertViewportScrollsSettings(page);
		await page.evaluate(() => {
			window.scrollTo(0, 0);
		});
		await page.screenshot({fullPage: true, path: resolve(screenshotDirectory, "settings-mobile.png")});
	} finally {
		await context.close();
	}
});

test("generated pairing code leads the desktop result after copy feedback clears", async ({browser}) => {
	const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {height: 768, width: 1440}});
	const page = await context.newPage();
	try {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await generatePairingCode(page);
		await expect(page.locator(".copy-status")).toHaveText("Copied to clipboard.");
		await expect(page.locator(".copy-status")).toBeEmpty();
		await expect(page.getByRole("status")).toHaveText("Waiting for your CLI to claim this code.");
		await expect(page.getByText("Pairing code", {exact: true})).toBeVisible();
		await expect(page.getByText("Paste this code into the CLI you want to connect.")).toBeVisible();
		await page.screenshot({fullPage: true, path: resolve(screenshotDirectory, "pairing-code-generated.png")});
	} finally {
		await context.close();
	}
});

test("copied pairing code keeps the repeat-copy control visually neutral", async ({browser}) => {
	const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {height: 768, width: 1440}});
	const page = await context.newPage();
	try {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await generatePairingCode(page);
		await expect(page.locator(".copy-status")).toHaveText("Copied to clipboard.");
		const copyAgain = page.getByRole("button", {name: "Copy pairing code again"});
		expect(
			await copyAgain.evaluate((element) => {
				const style = getComputedStyle(element);
				return {
					backgroundColor: style.backgroundColor,
					borderColor: style.borderColor,
					color: style.color,
					fontSize: style.fontSize,
				};
			}),
		).toStrictEqual({
			backgroundColor: "rgba(0, 0, 0, 0)",
			borderColor: "rgb(65, 69, 78)",
			color: "rgb(174, 180, 190)",
			fontSize: "12px",
		});
		await page.screenshot({fullPage: true, path: resolve(screenshotDirectory, "pairing-code-copied.png")});
	} finally {
		await context.close();
	}
});

test("blocked clipboard access leaves a selected manual-copy fallback", async ({browser}) => {
	const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {height: 768, width: 1440}});
	await context.addInitScript(() => {
		const blockedClipboard = {
			write: async () => Promise.reject(new DOMException("Clipboard access blocked", "NotAllowedError")),
			writeText: async () => Promise.reject(new DOMException("Clipboard access blocked", "NotAllowedError")),
		};
		Object.defineProperty(navigator, "clipboard", {configurable: true, value: blockedClipboard});
	});
	const page = await context.newPage();
	try {
		await generatePairingCode(page);
		await expect(page.locator(".copy-status")).toHaveText(
			"Clipboard access is blocked. Copy the selected code manually.",
		);
		expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("ABC234");
		await page.screenshot({
			fullPage: true,
			path: resolve(screenshotDirectory, "pairing-code-clipboard-blocked.png"),
		});
	} finally {
		await context.close();
	}
});

test("pairing code remains dominant at a narrow mobile width", async ({browser}) => {
	const context = await browser.newContext({
		ignoreHTTPSErrors: true,
		isMobile: true,
		viewport: {height: 844, width: 390},
	});
	const page = await context.newPage();
	try {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await generatePairingCode(page);
		const codeBounds = await page.locator("code.pairing-code").boundingBox();
		const resultBounds = await page.locator(".pairing-result").boundingBox();
		if (codeBounds === null || resultBounds === null) {
			throw new Error("responsive pairing bounds are missing");
		}
		expect({
			resultLeft: resultBounds.x,
			resultRight: resultBounds.x + resultBounds.width,
			viewportWidth: 390,
		}).toStrictEqual({
			resultLeft: 33,
			resultRight: 357,
			viewportWidth: 390,
		});
		expect(codeBounds.x).toBeGreaterThanOrEqual(resultBounds.x);
		expect(codeBounds.x + codeBounds.width).toBeLessThanOrEqual(resultBounds.x + resultBounds.width);
		await page.screenshot({fullPage: true, path: resolve(screenshotDirectory, "pairing-code-narrow-mobile.png")});
	} finally {
		await context.close();
	}
});
