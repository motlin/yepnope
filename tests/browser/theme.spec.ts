import {resolve} from "node:path";
import {expect, test, type Browser, type Page} from "playwright/test";
import {THEME_STORAGE_KEY, type ResolvedTheme} from "../../src/theme";
import {fulfillJson} from "./helpers";

// 🌗 Both palettes, photographed on every themed surface at a desktop width and at 320px, plus the
// three behaviours the palette cannot show on its own: follow-system is the default, an explicit
// choice outranks the system in both directions, and that choice survives a reload.

const screenshotDirectory = resolve(import.meta.dirname, "../../.llm/screenshots");

const PAGE_BACKGROUNDS: Record<ResolvedTheme, string> = {dark: "rgb(23, 24, 28)", light: "rgb(241, 242, 244)"};

const oauthQuery = new URLSearchParams({
	client_id: "codex-mcp-client",
	resource: "https://localhost:4173/mcp",
	scope: "openid offline_access yepnope:questions",
	sig: "signed-authorization-request",
}).toString();

const loopbackCallback = "http://127.0.0.1:57015/callback/4FAwZNJbSB0T?code=test-code&state=test-state";

interface Surface {
	name: string;
	open: (page: Page) => Promise<void>;
	signedIn: boolean;
}

const SURFACES: Surface[] = [
	{
		name: "deck",
		signedIn: true,
		open: async (page) => {
			await page.goto("/");
			await expect(page.getByText("Ship the release branch?")).toBeVisible();
		},
	},
	{
		name: "settings",
		signedIn: true,
		open: async (page) => {
			await page.goto("/settings");
			await expect(page.getByRole("heading", {name: "Appearance"})).toBeVisible();
		},
	},
	{
		// The longest strings in the app are here: config snippets nothing can shorten, so a narrow
		// phone is where a page-wide horizontal scrollbar would show up first.
		name: "connect",
		signedIn: true,
		open: async (page) => {
			await page.goto("/connect");
			await expect(page.getByRole("heading", {name: "Connect an MCP client"})).toBeVisible();
		},
	},
	{
		name: "oauth-consent",
		signedIn: true,
		open: async (page) => {
			await page.goto(`/oauth/consent?${oauthQuery}`);
			await expect(page.getByRole("button", {name: "Allow", exact: true})).toBeVisible();
		},
	},
	{
		name: "oauth-handoff",
		signedIn: true,
		open: async (page) => {
			await page.goto(`/oauth/consent?${oauthQuery}`);
			await page.getByRole("button", {name: "Allow", exact: true}).click();
			await expect(page.getByRole("heading", {name: "Connection authorized"})).toBeVisible();
		},
	},
	{
		name: "sign-in",
		signedIn: false,
		open: async (page) => {
			await page.goto("/sign-in");
			await expect(page.getByRole("heading", {name: "Sign in"})).toBeVisible();
		},
	},
	{
		name: "verify-email",
		signedIn: false,
		open: async (page) => {
			await page.goto("/verify-email");
			await expect(page.getByRole("heading", {name: "Verify your email"})).toBeVisible();
		},
	},
];

/** One mutable session, so a signed-out surface never leaves a stale route behind it. */
const session = {signedIn: true};

async function routeApplication(page: Page): Promise<void> {
	await page.route("**/api/auth/get-session", async (route) =>
		fulfillJson(
			route,
			session.signedIn ? {user: {email: "alice@example.com", emailVerified: true, id: "user-alice"}} : null,
		),
	);
	await page.route("**/api/v1/afk", async (route) => fulfillJson(route, {afk: false}));
	await page.route("**/api/v1/auth-methods", async (route) =>
		fulfillJson(route, {
			email_password: true,
			magic_link: true,
			passkey: false,
			social: [],
			turnstile_site_key: null,
		}),
	);
	await page.route("**/api/v1/account/devices", async (route) =>
		fulfillJson(route, {
			browser_sessions: [
				{
					id: "browser-session",
					display_name: "Safari on iPhone",
					created_at: 946_684_800_000,
					last_active_at: 946_771_200_000,
					expires_at: 947_289_600_000,
					current: true,
				},
			],
			connected_mcp_clients: [
				{
					id: "connected-client",
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
	await page.route("**/api/auth/list-accounts", async (route) => fulfillJson(route, []));
	await page.route("**/api/auth/passkey/list-user-passkeys", async (route) => fulfillJson(route, []));
	await page.route("**/api/auth/oauth2/public-client**", async (route) =>
		fulfillJson(route, {client_id: "codex-mcp-client", client_name: "Codex"}),
	);
	await page.route("**/api/auth/oauth2/consent", async (route) =>
		fulfillJson(route, {redirect: true, url: loopbackCallback}),
	);
	await page.route("http://127.0.0.1:57015/**", async (route) => route.fulfill({status: 204}));
	await page.routeWebSocket("**/api/v1/current-deck/stream", (socket) => {
		socket.send(
			JSON.stringify({
				type: "current_deck",
				afk: false,
				connected_mcp_client_count: 1,
				current_deck: [
					{
						batch_id: "batch-theme",
						project: "YepNope",
						repo: "motlin/yepnope",
						branch: "main",
						worktree: "/w/yepnope-main",
						directory: "/w/yepnope-main/src",
						question_id: "batch-theme:0",
						position: 0,
						title: "Ship the release branch?",
						body: "The release branch is green. Answering **Yep** tags it and deploys.",
						created_at: 946_684_800_000,
					},
				],
			}),
		);
	});
}

async function paintedTheme(page: Page): Promise<{background: string; scheme: string; themeColor: string | null}> {
	return page.evaluate(() => ({
		background: getComputedStyle(document.body).backgroundColor,
		scheme: getComputedStyle(document.documentElement).colorScheme,
		themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null,
	}));
}

interface Layout {
	isMobile: boolean;
	name: string;
	viewport: {height: number; width: number};
}

const DESKTOP: Layout = {isMobile: false, name: "desktop", viewport: {height: 900, width: 1440}};
const NARROW: Layout = {isMobile: true, name: "narrow", viewport: {height: 568, width: 320}};

async function openThemedContext(browser: Browser, theme: ResolvedTheme, layout: Layout): Promise<Page> {
	const context = await browser.newContext({
		colorScheme: theme,
		ignoreHTTPSErrors: true,
		isMobile: layout.isMobile,
		viewport: layout.viewport,
	});
	const page = await context.newPage();
	session.signedIn = true;
	await routeApplication(page);
	return page;
}

for (const theme of ["light", "dark"] as ResolvedTheme[]) {
	for (const layout of [DESKTOP, NARROW]) {
		test(`every themed surface follows a ${theme} system on a ${layout.name} window`, async ({browser}) => {
			const page = await openThemedContext(browser, theme, layout);
			try {
				for (const surface of SURFACES) {
					session.signedIn = surface.signedIn;
					await surface.open(page);
					await expect
						.poll(async () => ({
							...(await paintedTheme(page)),
							attribute: await page.locator("html").getAttribute("data-theme"),
							horizontalScroll: await page.evaluate(
								() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
							),
							surface: surface.name,
						}))
						.toStrictEqual({
							attribute: null,
							background: PAGE_BACKGROUNDS[theme],
							horizontalScroll: false,
							scheme: theme,
							surface: surface.name,
							themeColor: theme === "dark" ? "#17181c" : "#f1f2f4",
						});
					await page.screenshot({
						fullPage: true,
						path: resolve(screenshotDirectory, `theme-${theme}-${surface.name}-${layout.name}.png`),
					});
				}
			} finally {
				await page.context().close();
			}
		});
	}
}

test("an explicit choice outranks the system palette in both directions and survives a reload", async ({browser}) => {
	const page = await openThemedContext(browser, "dark", DESKTOP);
	try {
		await page.goto("/settings");
		await expect(page.getByRole("heading", {name: "Appearance"})).toBeVisible();
		await expect
			.poll(async () => paintedTheme(page))
			.toStrictEqual({
				background: PAGE_BACKGROUNDS.dark,
				scheme: "dark",
				themeColor: "#17181c",
			});

		// Light chosen against a dark system.
		await page.getByRole("radio", {name: "Light"}).check();
		await expect
			.poll(async () => ({
				...(await paintedTheme(page)),
				attribute: await page.locator("html").getAttribute("data-theme"),
				stored: await page.evaluate((key) => window.localStorage.getItem(key), THEME_STORAGE_KEY),
			}))
			.toStrictEqual({
				attribute: "light",
				background: PAGE_BACKGROUNDS.light,
				scheme: "light",
				stored: "light",
				themeColor: "#f1f2f4",
			});

		// A reload repaints from storage, and the pre-paint script means it was never dark first.
		await page.reload();
		await expect(page.getByRole("radio", {name: "Light"})).toBeChecked();
		await expect
			.poll(async () => paintedTheme(page))
			.toStrictEqual({
				background: PAGE_BACKGROUNDS.light,
				scheme: "light",
				themeColor: "#f1f2f4",
			});

		// Dark chosen against a light system is the same rule pointing the other way.
		await page.emulateMedia({colorScheme: "light"});
		await page.getByRole("radio", {name: "Dark"}).check();
		await expect
			.poll(async () => paintedTheme(page))
			.toStrictEqual({
				background: PAGE_BACKGROUNDS.dark,
				scheme: "dark",
				themeColor: "#17181c",
			});
	} finally {
		await page.context().close();
	}
});

test("handing the theme back to the system makes it live again without a reload", async ({browser}) => {
	const page = await openThemedContext(browser, "light", DESKTOP);
	try {
		await page.goto("/settings");
		await page.getByRole("radio", {name: "Dark"}).check();
		await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

		// While an explicit choice stands, the system moving underneath changes nothing.
		await page.emulateMedia({colorScheme: "dark"});
		await page.emulateMedia({colorScheme: "light"});
		await expect
			.poll(async () => paintedTheme(page))
			.toStrictEqual({
				background: PAGE_BACKGROUNDS.dark,
				scheme: "dark",
				themeColor: "#17181c",
			});

		await page.getByRole("radio", {name: "Match system"}).check();
		await expect
			.poll(async () => ({
				...(await paintedTheme(page)),
				attribute: await page.locator("html").getAttribute("data-theme"),
			}))
			.toStrictEqual({
				attribute: null,
				background: PAGE_BACKGROUNDS.light,
				scheme: "light",
				themeColor: "#f1f2f4",
			});

		await page.emulateMedia({colorScheme: "dark"});
		await expect
			.poll(async () => paintedTheme(page))
			.toStrictEqual({
				background: PAGE_BACKGROUNDS.dark,
				scheme: "dark",
				themeColor: "#17181c",
			});
	} finally {
		await page.context().close();
	}
});
