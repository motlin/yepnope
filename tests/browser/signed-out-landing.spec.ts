import {expect, test, type Page, type WebSocketRoute} from "playwright/test";
import {fulfillJson} from "./helpers";

const signedOutCopy = "Sign in to answer questions from your coding agents, or create an account to get started.";
// §13.2 asks for the no-E2EE disclosure "plainly on the site", which includes the front door a
// visitor reaches before they have an account and the two forms that front door leads to. The
// closing sentence is the Turnstile disclosure, on the landing before the widget itself appears.
const signedOutPrivacyCopy =
	"YepNope can read question bodies and answers. End-to-end encryption is not part of this MVP. Question bodies and answers are deleted seven days after each batch is created. Signing in and creating an account send this browser through a Cloudflare Turnstile check.";

async function assertSignedOutPrivacy(page: Page): Promise<void> {
	const notes = await page
		.locator(".signed-out-privacy")
		.evaluateAll((found) => found.map((note) => note.textContent));
	expect(notes).toStrictEqual([signedOutPrivacyCopy]);
}

async function assertSignedOutLanding(page: Page): Promise<void> {
	expect(
		await page.locator("body").evaluate((body) => ({
			actions: [...body.querySelectorAll(".signed-out-actions button")].map((button) => ({
				className: button.className,
				text: button.textContent,
				type: button.getAttribute("type"),
			})),
			applicationClass: body.querySelector(".app")?.className,
			authenticatedShells: body.querySelectorAll(
				".app-header, .deck, .deck-header, .actions, .card, .resolved, .settings, .settings-button, .afk-toggle, .account-status",
			).length,
			headings: [...body.querySelectorAll("h1, h2, h3")].map((heading) => heading.textContent),
			paragraphs: [...body.querySelectorAll(".account-panel > p")].map((paragraph) => paragraph.textContent),
		})),
	).toStrictEqual({
		actions: [
			{className: "", text: "Sign in", type: "button"},
			{className: "secondary", text: "Create account", type: "button"},
		],
		applicationClass: "app",
		authenticatedShells: 0,
		headings: ["YepNope"],
		paragraphs: [signedOutCopy, signedOutPrivacyCopy],
	});
}

test("signed-out auth routes always return to the landing without flashing a deck", async ({browser}) => {
	const context = await browser.newContext({
		ignoreHTTPSErrors: true,
		isMobile: true,
		viewport: {height: 568, width: 320},
	});
	const page = await context.newPage();
	try {
		await page.route("**/api/auth/get-session", async (route) => fulfillJson(route, null));
		await page.route("**/api/auth/sign-in/email", async (route) =>
			fulfillJson(
				route,
				{
					code: "AUTHENTICATION_FAILED",
					message: "Sign-in failed. Check your email and password, or recover your account.",
				},
				401,
			),
		);
		await page.addInitScript(() => {
			const observed = window as Window & {signedOutForbiddenSurfaces?: string[]};
			const forbiddenSurfaces: string[] = [];
			observed.signedOutForbiddenSurfaces = forbiddenSurfaces;
			new MutationObserver(() => {
				for (const selector of [".app-header", ".deck", ".settings", ".afk-toggle", ".settings-button"]) {
					if (document.querySelector(selector) !== null && !forbiddenSurfaces.includes(selector)) {
						forbiddenSurfaces.push(selector);
					}
				}
				if (document.body.textContent.includes("All caught up")) {
					forbiddenSurfaces.push("All caught up");
				}
			}).observe(document, {childList: true, subtree: true});
		});

		await page.goto("/");
		await expect(page.getByRole("heading", {name: "YepNope"})).toBeVisible();
		await assertSignedOutLanding(page);
		const applicationBounds = await page.locator(".app").boundingBox();
		const panelBounds = await page.locator(".account-panel").boundingBox();
		if (applicationBounds === null || panelBounds === null) {
			throw new Error("signed-out landing bounds are missing");
		}
		expect({
			applicationHeight: applicationBounds.height,
			applicationWidth: applicationBounds.width,
			applicationX: applicationBounds.x,
			panelRight: panelBounds.x + panelBounds.width,
			panelWidth: panelBounds.width,
			panelX: panelBounds.x,
		}).toStrictEqual({
			applicationHeight: 568,
			applicationWidth: 320,
			applicationX: 0,
			panelRight: 304,
			panelWidth: 288,
			panelX: 16,
		});

		await page.getByRole("button", {name: "Sign in"}).click();
		await assertSignedOutPrivacy(page);
		await page.getByRole("textbox", {name: "Email"}).fill("alice@example.com");
		await page.getByLabel("Password").fill("wrong-password");
		await page.getByRole("button", {name: "Sign in", exact: true}).click();
		await expect(page.getByRole("alert")).toHaveText(
			"Sign-in failed. Check your email and password, or recover your account.",
		);
		await page.getByRole("button", {name: "Back to YepNope"}).click();
		await expect(page).toHaveURL(/\/$/);
		await assertSignedOutLanding(page);

		await page.getByRole("button", {name: "Create account"}).click();
		await expect(page).toHaveURL(/\/register$/);
		await assertSignedOutPrivacy(page);
		await page.goBack();
		await expect(page).toHaveURL(/\/$/);
		await assertSignedOutLanding(page);

		for (const path of ["/register", "/verify-email", "/forgot-password", "/reset-password?error=INVALID_TOKEN"]) {
			await page.goto(path);
			await page.getByRole("button", {name: "Back to YepNope"}).click();
			await expect(page).toHaveURL(/\/$/);
			await assertSignedOutLanding(page);
		}

		await page.reload();
		await assertSignedOutLanding(page);
		expect(
			await page.evaluate(
				() => (window as Window & {signedOutForbiddenSurfaces?: string[]}).signedOutForbiddenSurfaces,
			),
		).toStrictEqual([]);
	} finally {
		await context.close();
	}
});

test("an expired session clears the deck and rejects late WebSocket state", async ({page}) => {
	const user = {email: "alice@example.com", emailVerified: true, id: "user-alice"};
	let resolveStream: (stream: WebSocketRoute) => void = () => undefined;
	const streamOpened = new Promise<WebSocketRoute>((resolve) => {
		resolveStream = resolve;
	});
	await page.route("**/api/auth/get-session", async (route) => fulfillJson(route, {user}));
	await page.route("**/api/v1/afk", async (route) => fulfillJson(route, {afk: false}));
	await page.route("**/api/v1/account/devices", async (route) =>
		fulfillJson(route, {message: "Session expired"}, 401),
	);
	await page.routeWebSocket("**/api/v1/current-deck/stream", (socket) => {
		resolveStream(socket);
	});

	await page.goto("/");
	await expect(page.getByRole("button", {name: "Settings"})).toBeVisible();
	const stream = await streamOpened;
	stream.send(
		JSON.stringify({
			type: "current_deck",
			afk: false,
			connected_mcp_client_count: 1,
			current_deck: [
				{
					batch_id: "batch-alice",
					body: "Delivered before the session expires.",
					branch: null,
					created_at: Date.UTC(2000, 0, 1),
					directory: null,
					position: 0,
					project: "Browser test",
					question_id: "batch-alice:0",
					repo: null,
					title: "Approve the expiring session?",
					worktree: null,
				},
			],
		}),
	);
	await expect(page.getByRole("heading", {name: "Approve the expiring session?"})).toBeVisible();
	await page.getByRole("button", {name: "Settings"}).click();
	await expect(page).toHaveURL(/\/$/);
	await assertSignedOutLanding(page);
	stream.send(
		JSON.stringify({
			type: "current_deck",
			afk: true,
			connected_mcp_client_count: 1,
			current_deck: [
				{
					batch_id: "batch-alice",
					body: "This late message must stay hidden.",
					branch: null,
					created_at: Date.UTC(2000, 0, 1),
					directory: null,
					position: 1,
					project: "Browser test",
					question_id: "batch-alice:1",
					repo: null,
					title: "Restore stale authenticated state?",
					worktree: null,
				},
			],
		}),
	);
	await expect(page.getByText("Restore stale authenticated state?")).toHaveCount(0);
	await assertSignedOutLanding(page);
});
