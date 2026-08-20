import {expect, type APIRequestContext, type Page, type Route} from "playwright/test";
import {z} from "zod";

const mailboxSchema = z.object({url: z.url()}).strict();
const sessionSchema = z.object({user: z.object({email: z.string().min(1), id: z.string().min(1)}).loose()}).loose();

/**
 * The `/api/__e2e__/mailbox` endpoint only answers once the Worker has actually delivered the
 * message, so every caller polls for the 200 before reading the link out of the body.
 */
export async function mailboxLink(request: APIRequestContext, subject: string, recipient: string): Promise<string> {
	await expect
		.poll(async () => {
			const response = await request.get("/api/__e2e__/mailbox", {params: {email: recipient, subject}});
			return response.status();
		})
		.toBe(200);
	const response = await request.get("/api/__e2e__/mailbox", {params: {email: recipient, subject}});
	return mailboxSchema.parse(await response.json()).url;
}

export async function sessionUser(page: Page): Promise<z.infer<typeof sessionSchema>["user"]> {
	const response = await page.request.get("/api/auth/get-session");
	expect(response.status()).toBe(200);
	return sessionSchema.parse(await response.json()).user;
}

export async function sessionUserId(page: Page): Promise<string> {
	return (await sessionUser(page)).id;
}

export async function sessionEmail(page: Page): Promise<string> {
	return (await sessionUser(page)).email;
}

export async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
	await route.fulfill({json: body, status});
}
