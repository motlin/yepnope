import {expect, test} from "playwright/test";
import {z} from "zod";
import {mailboxLink, sessionUserId} from "./helpers";

const pairingSchema = z.object({id: z.uuid(), code: z.string(), expiresAt: z.number()});

test("a desktop QR signs in an independent phone browser once", async ({page, browser}) => {
	const email = "alice-phone-pairing@example.com";
	await page.goto("/register");
	await page.getByLabel("Email", {exact: true}).fill(email);
	await page.getByLabel("Password", {exact: true}).fill("fake-phone-pairing-password");
	await page.getByRole("button", {name: "Create account", exact: true}).click();
	await page.goto(await mailboxLink(page.request, "Verify your YepNope email", email));
	await page.goto("/settings");
	const created = page.waitForResponse("**/api/auth/phone-pairing/create");
	await page.getByRole("button", {name: "Create QR code", exact: true}).click();
	const pairing = pairingSchema.parse(await (await created).json());
	await expect(page.getByRole("region", {name: "Pair a phone"}).locator("svg")).toHaveCount(1);
	await page
		.getByRole("region", {name: "Pair a phone"})
		.locator("svg")
		.screenshot({path: ".llm/phone-pairing-qr.png"});
	const desktopUserId = await sessionUserId(page);
	const phone = await browser.newContext({ignoreHTTPSErrors: true, viewport: {width: 390, height: 844}});
	try {
		const phonePage = await phone.newPage();
		const pairingUrl = `https://localhost:4173/pair-phone#id=${pairing.id}&code=${pairing.code}`;
		await phonePage.goto(pairingUrl);
		await expect(phonePage.getByLabel("Pairing code")).toHaveValue(pairing.code);
		await expect(phonePage).toHaveURL("https://localhost:4173/pair-phone");
		expect(await (await phonePage.request.get("https://localhost:4173/api/auth/get-session")).json()).toBe(null);
		await phonePage.getByRole("button", {name: "Sign in this phone", exact: true}).click();
		await expect(phonePage).toHaveURL("https://localhost:4173/settings");
		expect(await sessionUserId(phonePage)).toBe(desktopUserId);
		await expect(phonePage.getByText(email, {exact: true})).toBeVisible();
		await phonePage.goto(pairingUrl);
		await phonePage.getByRole("button", {name: "Sign in this phone", exact: true}).click();
		await expect(phonePage.getByRole("alert")).toHaveText(
			"This code is invalid or expired. Create a new QR code on your desktop.",
		);
	} finally {
		await phone.close();
	}
});
