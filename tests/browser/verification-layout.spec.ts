import {resolve} from "node:path";
import {expect, test, type Page, type Route} from "playwright/test";

const screenshotDirectory = resolve(import.meta.dirname, "../../.llm/screenshots");
const acceptedAuthenticationResponse = {
	message: "If the request can be completed, check your inbox for next steps.",
	status: true,
};

interface AuthenticationRequests {
	registrations: unknown[];
	verificationEmails: unknown[];
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
	await route.fulfill({json: body});
}

async function openPostRegistrationVerification(page: Page): Promise<AuthenticationRequests> {
	const requests: AuthenticationRequests = {registrations: [], verificationEmails: []};
	await page.route("**/api/auth/get-session", async (route) => fulfillJson(route, null));
	await page.route("**/api/auth/sign-up/email", async (route) => {
		requests.registrations.push(route.request().postDataJSON());
		await fulfillJson(route, acceptedAuthenticationResponse);
	});
	await page.route("**/api/auth/send-verification-email", async (route) => {
		requests.verificationEmails.push(route.request().postDataJSON());
		await fulfillJson(route, acceptedAuthenticationResponse);
	});
	await page.goto("/register");
	await page.getByRole("textbox", {name: "Email"}).fill("alice@example.com");
	await page.getByLabel("Password").fill("example-password");
	await page.getByRole("button", {name: "Create account"}).click();
	await expect(page.getByRole("heading", {name: "Verify your email"})).toBeVisible();
	return requests;
}

async function assertVerificationSurface(page: Page): Promise<void> {
	expect(
		await page.locator(".account-panel").evaluate((panel) => ({
			buttons: [...panel.querySelectorAll("button")].map((button) => ({
				ariaBusy: button.getAttribute("aria-busy"),
				disabled: button.disabled,
				text: button.textContent,
				type: button.type,
			})),
			forms: panel.querySelectorAll("form").length,
			headings: [...panel.querySelectorAll("h1")].map((heading) => heading.textContent),
			inputs: [...panel.querySelectorAll("input")].map((input) => ({name: input.name, value: input.value})),
			paragraphs: [...panel.querySelectorAll(":scope > p")].map((paragraph) => ({
				role: paragraph.getAttribute("role"),
				text: paragraph.textContent,
			})),
		})),
	).toStrictEqual({
		buttons: [
			{ariaBusy: "false", disabled: false, text: "Resend verification email", type: "button"},
			{ariaBusy: null, disabled: false, text: "Back to sign in", type: "button"},
			{ariaBusy: null, disabled: false, text: "Back to YepNope", type: "button"},
		],
		forms: 0,
		headings: ["Verify your email"],
		inputs: [],
		paragraphs: [
			{
				role: null,
				text: "If verification is available, use the emailed link to finish creating your account.",
			},
		],
	});
	expect(
		await page.locator("body").evaluate((body) => ({
			afks: body.querySelectorAll(".afk-toggle, .account-status").length,
			appHeaders: body.querySelectorAll(".app-header").length,
			deckHeaders: body.querySelectorAll(".deck-header").length,
			harnesses: body.querySelectorAll(".harness").length,
			settingsControls: body.querySelectorAll(".settings-button").length,
		})),
	).toStrictEqual({afks: 0, appHeaders: 0, deckHeaders: 0, harnesses: 0, settingsControls: 0});
}

test("verification is a focused desktop account route with accessible keyboard actions", async ({browser}) => {
	const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {height: 900, width: 1440}});
	const page = await context.newPage();
	try {
		const requests = await openPostRegistrationVerification(page);
		await assertVerificationSurface(page);
		expect(requests).toStrictEqual({
			registrations: [{callbackURL: "/verify-email", email: "alice@example.com", password: "example-password"}],
			verificationEmails: [{callbackURL: "/verify-email", email: "alice@example.com"}],
		});
		const applicationBounds = await page.locator(".app").boundingBox();
		const panelBounds = await page.locator(".account-panel").boundingBox();
		if (applicationBounds === null || panelBounds === null) {
			throw new Error("verification layout bounds are missing");
		}
		expect({
			applicationHeight: applicationBounds.height,
			applicationWidth: applicationBounds.width,
			applicationX: applicationBounds.x,
			panelWidth: panelBounds.width,
			panelX: panelBounds.x,
		}).toStrictEqual({
			applicationHeight: 900,
			applicationWidth: 480,
			applicationX: 480,
			panelWidth: 448,
			panelX: 496,
		});
		await page.screenshot({fullPage: true, path: resolve(screenshotDirectory, "verification-desktop.png")});

		await page.keyboard.press("Tab");
		const resend = page.getByRole("button", {name: "Resend verification email"});
		await expect(resend).toBeFocused();
		expect(
			await resend.evaluate((button) => {
				const style = getComputedStyle(button);
				return {
					outlineColor: style.outlineColor,
					outlineOffset: style.outlineOffset,
					outlineStyle: style.outlineStyle,
					outlineWidth: style.outlineWidth,
				};
			}),
		).toStrictEqual({
			outlineColor: "rgb(215, 218, 224)",
			outlineOffset: "2px",
			outlineStyle: "solid",
			outlineWidth: "2px",
		});
		await page.screenshot({fullPage: true, path: resolve(screenshotDirectory, "verification-keyboard-focus.png")});
		await page.keyboard.press("Enter");
		await expect(page.getByRole("status")).toHaveText(
			"If verification is available, a new link will arrive by email.",
		);
		expect(requests.verificationEmails).toStrictEqual([
			{callbackURL: "/verify-email", email: "alice@example.com"},
			{callbackURL: "/verify-email", email: "alice@example.com"},
		]);
		await page.keyboard.press("Tab");
		await expect(page.getByRole("button", {name: "Back to sign in"})).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/\/sign-in$/);
		await expect(page.locator(".app-header")).toHaveCount(0);
	} finally {
		await context.close();
	}
});

test("verification stays uncluttered at a narrow mobile size", async ({browser}) => {
	const context = await browser.newContext({
		ignoreHTTPSErrors: true,
		isMobile: true,
		viewport: {height: 568, width: 320},
	});
	const page = await context.newPage();
	try {
		await openPostRegistrationVerification(page);
		await assertVerificationSurface(page);
		const applicationBounds = await page.locator(".app").boundingBox();
		const panelBounds = await page.locator(".account-panel").boundingBox();
		if (applicationBounds === null || panelBounds === null) {
			throw new Error("narrow verification layout bounds are missing");
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
		await page.screenshot({fullPage: true, path: resolve(screenshotDirectory, "verification-narrow-mobile.png")});
	} finally {
		await context.close();
	}
});
