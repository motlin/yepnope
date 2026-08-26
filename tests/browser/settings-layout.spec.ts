import {resolve} from "node:path";
import {expect, test, type Page} from "playwright/test";
import {fulfillJson} from "./helpers";

const screenshotDirectory = resolve(import.meta.dirname, "../../.llm/screenshots");

async function routeSettingsData(page: Page): Promise<void> {
	await page.route("**/api/auth/get-session", async (route) =>
		fulfillJson(route, {
			user: {id: "user-alice", email: "alice@example.com", emailVerified: true},
		}),
	);
	await page.route("**/api/v1/afk", async (route) => fulfillJson(route, {afk: false}));
	await page.route("**/api/v1/account/devices", async (route) =>
		fulfillJson(route, {
			browser_sessions: [
				{
					id: "browser-session-management-id",
					display_name: "Safari on iPhone",
					created_at: 946_684_800_000,
					last_active_at: 946_771_200_000,
					expires_at: 947_289_600_000,
					current: true,
				},
			],
			connected_mcp_clients: [
				{
					id: "connected-mcp-client-management-id",
					display_name: "Alice laptop",
					authorized_at: 946_684_800_000,
					last_used_at: null,
					granted_scopes: ["yepnope:questions"],
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

async function openSettings(page: Page): Promise<void> {
	await routeSettingsData(page);
	await page.goto("/settings");
	await expect(page.getByRole("heading", {name: "Privacy and retention"})).toBeVisible();
	await expect(page.getByRole("button", {name: "Back to the deck"})).toBeVisible();
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

test("settings separates account access, MCP clients, and browser notifications", async ({browser}) => {
	const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {height: 768, width: 1440}});
	const page = await context.newPage();
	try {
		await openSettings(page);
		await expect(page.getByRole("heading", {name: "Connected MCP clients"})).toBeVisible();
		await expect(page.getByRole("heading", {name: "Signed-in browsers"})).toBeVisible();
		await expect(page.getByRole("heading", {name: "Browser notifications"})).toBeVisible();
		await expect(page.getByText("Alice laptop")).toBeVisible();
		await expect(page.getByText("Safari on iPhone · This browser")).toBeVisible();
		await expect(page.getByText("Alice phone")).toBeVisible();
		await expect(page.getByRole("heading", {name: "Claude Code"})).toBeVisible();
		await expect(page.getByText("claude plugin install yepnope@yepnope")).toBeVisible();
		await expect(
			page.getByText("claude mcp add --scope local --transport http yepnope https://yepnope.app/mcp"),
		).toBeVisible();
		await expect(page.getByRole("heading", {name: "Codex"})).toBeVisible();
		await expect(page.getByText("codex plugin add yepnope@yepnope")).toBeVisible();
		await expect(
			page.getByText(
				"Alternative: use the manual commands only if you did not install the plugin. Combining both paths creates a redundant top-level MCP registration.",
			),
		).toBeVisible();
		await expect(page.getByText("codex mcp add yepnope --url https://yepnope.app/mcp")).toBeVisible();
		await expect(page.getByText("codex mcp login yepnope")).toBeVisible();
		expect((await page.locator("body").innerText()).toLowerCase()).not.toContain("pair");
		await page.screenshot({fullPage: true, path: resolve(screenshotDirectory, "settings-account-access.png")});
	} finally {
		await context.close();
	}
});

test("install commands stay copyable within a narrow mobile width", async ({browser}) => {
	const context = await browser.newContext({
		ignoreHTTPSErrors: true,
		isMobile: true,
		viewport: {height: 844, width: 390},
	});
	const page = await context.newPage();
	try {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await openSettings(page);
		// The longest command in the panel, so wrapping is proven where it is hardest.
		const command = page.getByText("claude mcp add --scope local --transport http yepnope https://yepnope.app/mcp");
		const commandBounds = await command.boundingBox();
		const containerBounds = await command.locator("xpath=../..").boundingBox();
		if (commandBounds === null || containerBounds === null) {
			throw new Error("responsive command bounds are missing");
		}
		expect({
			containerLeft: containerBounds.x,
			containerRight: containerBounds.x + containerBounds.width,
			viewportWidth: 390,
		}).toStrictEqual({
			containerLeft: 33,
			containerRight: 357,
			viewportWidth: 390,
		});
		expect(commandBounds.x).toBeGreaterThanOrEqual(containerBounds.x);
		expect(commandBounds.x + commandBounds.width).toBeLessThanOrEqual(containerBounds.x + containerBounds.width);
		await command.locator("xpath=../../button").click();
		await expect(command.locator("xpath=../../button")).toHaveText("Copied");
		await page.screenshot({fullPage: true, path: resolve(screenshotDirectory, "settings-install-mobile.png")});
	} finally {
		await context.close();
	}
});
