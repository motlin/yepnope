import {expect, test, type APIRequestContext, type Page} from "playwright/test";
import {TURNSTILE_SCRIPT_PATTERN, TURNSTILE_STUB_SCRIPT, type TurnstileStubBehavior} from "./turnstile-stub";

// 📄 The file name matters. Playwright runs these specs in file-name order and
// identity-lifecycle.spec.ts asserts a database with no accounts in it at all, so any spec that
// creates one has to sort after it.

// Cloudflare's documented Turnstile test keys.
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const ALWAYS_PASSES_SITE_KEY = "1x00000000000000000000AA";
const ALWAYS_PASSES_SECRET_KEY = "1x0000000000000000000000000000000AA";
const ALWAYS_FAILS_SECRET_KEY = "2x0000000000000000000000000000000AA";

const VERIFICATION_SUBJECT = "Verify your YepNope email";
const PASSWORD = "browser-test-human-verification-password";
const REFUSED_COPY = "Human verification did not complete. Complete the check on the page and try again.";
const UNAVAILABLE_COPY = "We could not verify this browser. Retry the check below, then submit again.";

function uniqueEmail(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}@example.com`;
}

async function enforceHumanVerification(
	request: APIRequestContext,
	secretKey = ALWAYS_PASSES_SECRET_KEY,
): Promise<void> {
	const response = await request.post("/api/__e2e__/turnstile", {
		data: {secret_key: secretKey, site_key: ALWAYS_PASSES_SITE_KEY},
	});
	expect(response.status()).toBe(200);
}

async function waiveHumanVerification(request: APIRequestContext): Promise<void> {
	const response = await request.post("/api/__e2e__/turnstile", {data: {enabled: false}});
	expect(response.status()).toBe(200);
}

/** Serves the stand-in widget script in place of Cloudflare's, before anything on the page runs. */
async function stubTurnstile(page: Page, behavior: TurnstileStubBehavior = "passes"): Promise<void> {
	await page.addInitScript((mode) => {
		(window as unknown as {__turnstileStubBehavior: string}).__turnstileStubBehavior = mode;
	}, behavior);
	await page.route(TURNSTILE_SCRIPT_PATTERN, async (route) => {
		await route.fulfill({body: TURNSTILE_STUB_SCRIPT, contentType: "application/javascript"});
	});
}

function verificationGroup(page: Page) {
	return page.getByRole("group", {name: "Human verification"});
}

/** The check has its own polite status line, distinct from the form's own success message. */
function verificationStatus(page: Page) {
	return verificationGroup(page).getByRole("status");
}

test.afterEach(async ({request}) => {
	await waiveHumanVerification(request);
});

test("a solved check carries the account through creation and verification", async ({page, request}) => {
	await enforceHumanVerification(request);
	await stubTurnstile(page);
	const email = uniqueEmail("verified-human");

	await page.goto("/register");
	await expect(verificationStatus(page)).toHaveText("Human verification complete.");
	await page.getByRole("textbox", {name: "Email"}).fill(email);
	await page.getByLabel("Password").fill(PASSWORD);
	await page.getByRole("button", {name: "Create account", exact: true}).click();

	await expect(page.getByRole("heading", {name: "Verify your email"})).toBeVisible();
	await expect
		.poll(async () => {
			const mailbox = await request.get("/api/__e2e__/mailbox", {
				params: {email, subject: VERIFICATION_SUBJECT},
			});
			return mailbox.status();
		})
		.toBe(200);
});

test("the submit stays inert until the check has actually produced something to send", async ({page, request}) => {
	await enforceHumanVerification(request);
	await stubTurnstile(page, "interactive");

	await page.goto("/sign-in");
	await page.getByRole("textbox", {name: "Email"}).fill(uniqueEmail("interactive"));
	await page.getByLabel("Password").fill(PASSWORD);
	const signIn = page.getByRole("button", {name: "Sign in", exact: true});

	await expect(signIn).toBeDisabled();
	await expect(verificationStatus(page)).toHaveText("Checking that you are human…");

	// The interactive challenge is a real control the keyboard reaches on its own.
	await page.getByRole("button", {name: "Verify you are human"}).focus();
	await page.keyboard.press("Enter");

	await expect(verificationStatus(page)).toHaveText("Human verification complete.");
	await expect(signIn).toBeEnabled();
});

test("a refused challenge explains itself and sends nothing", async ({page, request}) => {
	await enforceHumanVerification(request);
	await stubTurnstile(page, "blocks");
	const authenticationRequests: string[] = [];
	page.on("request", (intercepted) => {
		if (intercepted.url().includes("/api/auth/sign-in/")) {
			authenticationRequests.push(intercepted.url());
		}
	});

	await page.goto("/sign-in");
	await page.getByRole("textbox", {name: "Email"}).fill(uniqueEmail("blocked"));
	await page.getByLabel("Password").fill(PASSWORD);

	await expect(page.getByRole("alert")).toHaveText(UNAVAILABLE_COPY);
	await expect(page.getByRole("button", {name: "Sign in", exact: true})).toBeDisabled();
	await expect(page.getByRole("button", {name: "Email me a sign-in link"})).toBeDisabled();
	await expect(page.getByRole("button", {name: "Retry verification"})).toBeVisible();
	expect(authenticationRequests).toStrictEqual([]);
});

// 🕸️ A blocked script is the honest stand-in for a browser that cannot run Cloudflare's widget at
// all: an extension, a filtering proxy, a network that drops the request. The page must say so.
test("a widget script that never arrives leaves a stated failure rather than a dead form", async ({page, request}) => {
	await enforceHumanVerification(request);
	await page.route(TURNSTILE_SCRIPT_PATTERN, async (route) => {
		await route.abort();
	});

	await page.goto("/forgot-password");
	await page.getByRole("textbox", {name: "Email"}).fill(uniqueEmail("no-script"));

	await expect(page.getByRole("alert")).toHaveText(UNAVAILABLE_COPY);
	await expect(page.getByRole("button", {name: "Send recovery email"})).toBeDisabled();
});

test("an expired check is rerun and the form recovers on its own", async ({page, request}) => {
	await enforceHumanVerification(request);
	await stubTurnstile(page);

	await page.goto("/forgot-password");
	await page.getByRole("textbox", {name: "Email"}).fill(uniqueEmail("expiring"));
	await expect(verificationStatus(page)).toHaveText("Human verification complete.");

	await page.evaluate(() => {
		(window as unknown as {__turnstileStubExpire: () => void}).__turnstileStubExpire();
	});

	await expect(verificationStatus(page)).toHaveText("Human verification complete.");
	await expect(page.getByRole("button", {name: "Send recovery email"})).toBeEnabled();
	await page.getByRole("button", {name: "Send recovery email"}).click();
	await expect(page.locator(".form-success")).toHaveText(
		"If recovery is available for that address, check its inbox for next steps.",
	);
});

// 🛡️ The widget is a courtesy to the visitor. This is the part that actually stops anything.
test("posting straight at the endpoint is refused, with or without a borrowed token", async ({page, request}) => {
	await enforceHumanVerification(request);
	await stubTurnstile(page);
	const email = uniqueEmail("direct-api");
	const submittedTokens: string[] = [];
	page.on("request", (intercepted) => {
		const token = intercepted.headers()["cf-turnstile-response"];
		if (token !== undefined) {
			submittedTokens.push(token);
		}
	});

	await page.goto("/forgot-password");
	await page.getByRole("textbox", {name: "Email"}).fill(email);
	await page.getByRole("button", {name: "Send recovery email"}).click();
	await expect(page.locator(".form-success")).toHaveText(
		"If recovery is available for that address, check its inbox for next steps.",
	);
	const spentToken = submittedTokens.at(0);

	const tokenless = await request.post("/api/auth/request-password-reset", {
		data: {email, redirectTo: "/reset-password"},
		failOnStatusCode: false,
	});
	const forged = await request.post("/api/auth/request-password-reset", {
		data: {email, redirectTo: "/reset-password"},
		failOnStatusCode: false,
		headers: {"CF-Turnstile-Response": "forged-token"},
	});
	const replayed = await request.post("/api/auth/request-password-reset", {
		data: {email, redirectTo: "/reset-password"},
		failOnStatusCode: false,
		headers: {"CF-Turnstile-Response": spentToken ?? ""},
	});

	expect({
		forged: {body: await forged.json(), status: forged.status()},
		replayed: {body: await replayed.json(), status: replayed.status()},
		tokenCaptured: spentToken !== undefined,
		tokenless: {body: await tokenless.json(), status: tokenless.status()},
	}).toStrictEqual({
		forged: {body: {code: "HUMAN_VERIFICATION_REQUIRED", message: REFUSED_COPY}, status: 403},
		replayed: {body: {code: "HUMAN_VERIFICATION_REQUIRED", message: REFUSED_COPY}, status: 403},
		tokenCaptured: true,
		tokenless: {body: {code: "HUMAN_VERIFICATION_REQUIRED", message: REFUSED_COPY}, status: 403},
	});
});

// 🔗 A refused check costs the visitor a retry, never the MCP client's whole authorization.
test("a refusal keeps the pending authorization request on the sign-in page", async ({page, request}) => {
	await enforceHumanVerification(request, ALWAYS_FAILS_SECRET_KEY);
	await stubTurnstile(page);
	const oauthQuery = new URLSearchParams({
		client_id: "human-verification-oauth-client",
		resource: "https://localhost:4173/mcp",
		scope: "openid offline_access yepnope:questions",
		sig: "signed-authorization-request",
	}).toString();

	await page.goto(`/sign-in?${oauthQuery}`);
	await page.getByRole("textbox", {name: "Email"}).fill(uniqueEmail("oauth-refused"));
	await page.getByLabel("Password").fill(PASSWORD);
	await page.getByRole("button", {name: "Sign in", exact: true}).click();

	await expect(page.getByRole("alert")).toHaveText(REFUSED_COPY);
	expect(`${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe(`/sign-in?${oauthQuery}`);
	await expect(page.getByRole("heading", {name: "Sign in"})).toBeVisible();
	await expect(verificationGroup(page)).toBeVisible();
});

test("the check reads as one field of the form on a narrow phone", async ({page, request}) => {
	await enforceHumanVerification(request);
	await stubTurnstile(page);
	await page.setViewportSize({height: 640, width: 320});

	await page.goto("/register");
	await expect(verificationGroup(page)).toBeVisible();

	const overflow = await page.evaluate(() => {
		const panel = document.querySelector(".account-panel");
		const group = document.querySelector(".human-verification");
		if (panel === null || group === null) {
			return null;
		}
		const panelBox = panel.getBoundingClientRect();
		const groupBox = group.getBoundingClientRect();
		return {
			documentScrollsSideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
			groupEscapesPanel: groupBox.left < panelBox.left - 1 || groupBox.right > panelBox.right + 1,
		};
	});

	expect(overflow).toStrictEqual({documentScrollsSideways: false, groupEscapesPanel: false});
});

test("the check names itself and discloses who is doing the checking", async ({page, request}) => {
	await enforceHumanVerification(request);
	await stubTurnstile(page);

	await page.goto("/sign-in");
	const group = verificationGroup(page);

	await expect(group).toBeVisible();
	await expect(group.getByText("Cloudflare Turnstile checks this browser", {exact: false})).toBeVisible();
	await expect(group.getByRole("link", {name: "Privacy Policy"})).toHaveAttribute(
		"href",
		"https://www.cloudflare.com/privacypolicy/",
	);
	await expect(verificationStatus(page)).toHaveAttribute("aria-live", "polite");
});

test("a deployment that configured no check draws none and still signs people in", async ({page, request}) => {
	await waiveHumanVerification(request);
	const email = uniqueEmail("waived");

	await page.goto("/register");
	await page.getByRole("textbox", {name: "Email"}).fill(email);
	await page.getByLabel("Password").fill(PASSWORD);
	await page.getByRole("button", {name: "Create account", exact: true}).click();

	await expect(page.getByRole("heading", {name: "Verify your email"})).toBeVisible();
	await expect(verificationGroup(page)).toHaveCount(0);
});
