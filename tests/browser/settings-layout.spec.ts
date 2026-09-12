import {resolve} from "node:path";
import {expect, test, type Page} from "playwright/test";
import {fulfillJson} from "./helpers";

const screenshotDirectory = resolve(import.meta.dirname, "../../.llm/screenshots");

async function routeSettingsData(page: Page): Promise<void> {
	await page.route("**/api/auth/list-accounts", async (route) => fulfillJson(route, []));
	await page.route("**/api/auth/passkey/list-user-passkeys", async (route) => fulfillJson(route, []));
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

const destinations = [
	{path: "/settings/account", title: "Account and sign-in", region: "Sign-in methods"},
	{path: "/settings/devices", title: "Phones and browsers", region: "Pair a phone"},
	{path: "/settings/appearance", title: "Appearance", region: "Appearance"},
	{path: "/settings/clients", title: "MCP clients", region: "Connected MCP clients"},
	{path: "/settings/notifications", title: "Notifications", region: null},
	{path: "/settings/privacy", title: "Privacy", region: null},
];

async function openConnect(page: Page): Promise<void> {
	await routeSettingsData(page);
	await page.goto("/connect");
	await expect(page.getByRole("heading", {name: "Connect an MCP client"})).toBeVisible();
	await expect(page.getByRole("button", {name: "Back to the deck"})).toBeVisible();
}

for (const width of [320, 390, 1440]) {
	test(`settings destinations fit a ${width}px viewport and load directly`, async ({browser}) => {
		const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {height: 768, width}});
		const page = await context.newPage();
		try {
			await routeSettingsData(page);
			await page.goto("/settings");
			await expect(page.getByRole("heading", {name: "Settings", exact: true})).toBeVisible();
			expect(
				await page
					.getByRole("navigation", {name: "Settings pages"})
					.getByRole("link")
					.evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
			).toStrictEqual(destinations.map((destination) => destination.path));
			await page.screenshot({fullPage: true, path: resolve(screenshotDirectory, `settings-${width}.png`)});
			for (const destination of destinations) {
				await page.goto(destination.path);
				await expect(page.getByRole("heading", {name: destination.title, exact: true})).toBeVisible();
				await expect(page).toHaveTitle(`${destination.title} · Settings · YepNope`);
				if (destination.region !== null)
					await expect(page.getByRole("region", {name: destination.region})).toBeVisible();
				await expect(page.getByRole("link", {name: "Settings", exact: true})).toHaveAttribute(
					"href",
					"/settings",
				);
				await expect(page.getByRole("link", {name: "Back to the deck"})).toHaveAttribute("href", "/");
				expect(
					await page.locator(".settings").evaluate((element) => ({
						overflow: getComputedStyle(element).overflowY,
						scrollWidth: document.documentElement.scrollWidth,
						width: window.innerWidth,
					})),
				).toStrictEqual({overflow: "visible", scrollWidth: width, width});
				await page.screenshot({
					fullPage: true,
					path: resolve(screenshotDirectory, `settings-${destination.path.split("/").at(-1)}-${width}.png`),
				});
			}
		} finally {
			await context.close();
		}
	});
}

test("settings navigation supports the keyboard, browser history, and the deck", async ({page}) => {
	await routeSettingsData(page);
	await page.goto("/settings");
	await expect(page.getByRole("heading", {name: "Settings", exact: true})).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(page.getByRole("link", {name: /^Account and sign-in/})).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/settings\/account$/);
	await expect(page.getByRole("heading", {name: "Account and sign-in"})).toBeFocused();
	await page.goBack();
	await expect(page.getByRole("heading", {name: "Settings", exact: true})).toBeFocused();
	await page.goForward();
	await expect(page.getByRole("heading", {name: "Account and sign-in"})).toBeFocused();
	await page.getByRole("link", {name: "Settings", exact: true}).click();
	await page.getByRole("link", {name: /^Phones and browsers/}).click();
	await expect(page.getByText("Safari on iPhone · This browser")).toBeVisible();
	await expect(page.getByRole("button", {name: "Create QR code"})).toBeVisible();
	await expect(page.getByRole("heading", {name: "Browser notifications"})).toHaveCount(0);
	await page.getByRole("link", {name: "Settings", exact: true}).click();
	await page.getByRole("link", {name: /^Notifications/}).click();
	await expect(page.getByText("Alice phone")).toBeVisible();
	await page.getByRole("link", {name: "Settings", exact: true}).click();
	await page.getByRole("link", {name: /^MCP clients/}).click();
	await expect(page.getByText("Alice laptop")).toBeVisible();
	await page.getByRole("button", {name: "Connect an MCP client"}).click();
	await expect(page).toHaveURL(/\/connect$/);
	await page.goBack();
	await expect(page.getByRole("heading", {name: "MCP clients", exact: true})).toBeFocused();
	await page.getByRole("link", {name: "Back to the deck"}).click();
	await expect(page).toHaveURL("https://localhost:4173/");
});

test("the connect page carries the setup steps for every supported client", async ({browser}) => {
	const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {height: 768, width: 1440}});
	const page = await context.newPage();
	try {
		await openConnect(page);
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
		await page.screenshot({fullPage: true, path: resolve(screenshotDirectory, "connect-clients.png")});
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
		await openConnect(page);
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
		await page.screenshot({fullPage: true, path: resolve(screenshotDirectory, "connect-install-mobile.png")});
	} finally {
		await context.close();
	}
});
