import {expect, test, type APIRequestContext, type Page} from "playwright/test";

const verificationSubject = "Verify your YepNope email";
const password = "browser-test-delivery-password";
const registrationCopy =
	"If verification is available for that address, the emailed link finishes creating your account. " +
	"Delivery can take a few minutes, and the message can land in spam.";
const resendCopy =
	"Verification was requested. If a link is available for that address, it can take a few minutes " +
	"to arrive, so check your spam folder too.";

function uniqueEmail(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}@example.com`;
}

async function mailboxStatus(request: APIRequestContext, recipient: string): Promise<number> {
	const response = await request.get("/api/__e2e__/mailbox", {
		params: {email: recipient, subject: verificationSubject},
	});
	return response.status();
}

async function register(page: Page, email: string): Promise<void> {
	await page.goto("/register");
	await page.getByRole("textbox", {name: "Email"}).fill(email);
	await page.getByLabel("Password").fill(password);
	await page.getByRole("button", {name: "Create account", exact: true}).click();
	await expect(page.getByRole("heading", {name: "Verify your email"})).toBeVisible();
}

test("a genuinely new account receives exactly one verification message", async ({page, request}) => {
	const email = uniqueEmail("delivery-new");

	await register(page, email);

	await expect.poll(async () => mailboxStatus(request, email)).toBe(200);
	expect({
		copy: await page.locator(".account-panel > p").first().textContent(),
		status: await mailboxStatus(request, email),
	}).toStrictEqual({copy: registrationCopy, status: 200});
});

// 🕳️ The production report: the browser is told the request was accepted and no message ever lands.
// The Worker's reply is deliberately identical to the healthy one, so the only honest thing the page
// can do is decline to promise delivery.
test("a rejected recipient leaves the browser with the same non-committal copy", async ({page, request}) => {
	const email = uniqueEmail("undeliverable-delivery");

	await register(page, email);
	await page.getByRole("button", {name: "Resend verification email"}).click();
	await expect(page.getByRole("status")).toBeVisible();

	expect({
		alerts: await page.getByRole("alert").count(),
		copy: await page.locator(".account-panel > p").first().textContent(),
		mailbox: await mailboxStatus(request, email),
		resendCopy: await page.getByRole("status").textContent(),
	}).toStrictEqual({
		alerts: 0,
		copy: registrationCopy,
		mailbox: 404,
		resendCopy,
	});
});
