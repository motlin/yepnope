import {expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page} from "playwright/test";
import {mailboxLink, sessionEmail} from "./helpers";

const magicLinkSubject = "Sign in to YepNope";
const verificationSubject = "Verify your YepNope email";
const passkeyPassword = "browser-test-passkey-password";

function uniqueEmail(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}@example.com`;
}

// Chrome's virtual authenticator stands in for a platform authenticator so the real WebAuthn
// ceremony runs end to end.
async function withVirtualAuthenticator(browser: Browser, body: (page: Page) => Promise<void>): Promise<void> {
	const context: BrowserContext = await browser.newContext({ignoreHTTPSErrors: true});
	try {
		const page = await context.newPage();
		const client = await context.newCDPSession(page);
		await client.send("WebAuthn.enable");
		await client.send("WebAuthn.addVirtualAuthenticator", {
			options: {
				protocol: "ctap2",
				transport: "internal",
				hasResidentKey: true,
				hasUserVerification: true,
				isUserVerified: true,
				automaticPresenceSimulation: true,
			},
		});
		await body(page);
	} finally {
		await context.close();
	}
}

async function registerVerifiedAccount(page: Page, request: APIRequestContext, email: string): Promise<void> {
	await page.goto("/register");
	await page.getByRole("textbox", {name: "Email"}).fill(email);
	await page.getByLabel("Password").fill(passkeyPassword);
	await page.getByRole("button", {name: "Create account", exact: true}).click();
	await page.goto(await mailboxLink(request, verificationSubject, email));
	await expect(page).toHaveURL(/\/$/);
	await page.goto("/settings");
	await expect(page.getByText(email)).toBeVisible();
}

test("an emailed sign-in link creates a session without a password", async ({page, request}) => {
	const email = uniqueEmail("magic-link-browser");

	await page.goto("/sign-in");
	await page.getByRole("textbox", {name: "Email"}).fill(email);
	await page.getByRole("button", {name: "Email me a sign-in link"}).click();
	await expect(page.getByRole("status")).toHaveText(
		"If the request can be completed, check your inbox for a sign-in link. It expires in 15 minutes.",
	);

	await page.goto(await mailboxLink(request, magicLinkSubject, email));

	await expect(page).toHaveURL(/\/$/);
	expect(await sessionEmail(page)).toBe(email);
});

test("a passkey registered in settings signs the same account back in", async ({browser, request}) => {
	await withVirtualAuthenticator(browser, async (page) => {
		const email = uniqueEmail("passkey-browser");
		await registerVerifiedAccount(page, request, email);

		const methods = page.getByRole("region", {name: "Sign-in methods"});
		await expect(methods.getByText("No passkeys yet.", {exact: false})).toBeVisible();
		await methods.getByRole("button", {name: "Add a passkey"}).click();
		await expect(methods.getByRole("listitem").getByRole("button", {name: "Remove"})).toBeVisible();

		await page.getByRole("button", {name: "Sign out"}).click();
		await page.goto("/sign-in");
		await page.getByRole("button", {name: "Sign in with a passkey"}).click();

		await expect(page).toHaveURL(/\/settings$/);
		expect(await sessionEmail(page)).toBe(email);
	});
});

test("a registered passkey can be removed again", async ({browser, request}) => {
	await withVirtualAuthenticator(browser, async (page) => {
		await registerVerifiedAccount(page, request, uniqueEmail("passkey-removal-browser"));

		const methods = page.getByRole("region", {name: "Sign-in methods"});
		await methods.getByRole("button", {name: "Add a passkey"}).click();
		await methods.getByRole("listitem").getByRole("button", {name: "Remove"}).click();

		await expect(methods.getByText("No passkeys yet.", {exact: false})).toBeVisible();
	});
});

test("a configured provider button leaves for that provider's authorization page", async ({page}) => {
	const authorizeUrls: string[] = [];
	await page.route("https://github.com/**", async (route) => {
		authorizeUrls.push(route.request().url());
		await route.fulfill({status: 200, contentType: "text/html", body: "<html><body>provider</body></html>"});
	});

	await page.goto("/sign-in");
	await page.getByRole("button", {name: "Continue with GitHub"}).click();

	await expect.poll(() => authorizeUrls.length).toBeGreaterThan(0);
	const authorize = new URL(authorizeUrls[0] ?? "");
	expect(`${authorize.origin}${authorize.pathname}`).toBe("https://github.com/login/oauth/authorize");
	expect(authorize.searchParams.get("client_id")).toBe("browser-e2e-github-client");
	expect(authorize.searchParams.get("redirect_uri")).toBe("https://localhost:4173/api/auth/callback/github");
});

test("an unconfigured provider is never offered", async ({page}) => {
	await page.goto("/sign-in");

	await expect(page.getByRole("button", {name: "Continue with GitHub"})).toBeVisible();
	await expect(page.getByRole("button", {name: "Continue with Google"})).toHaveCount(0);
});
