import {expect, type APIRequestContext, type Page, type Route} from "playwright/test";
import {z} from "zod";

const instanceSchema = z.object({instance_id: z.string().min(1)}).strict();
const mailboxSchema = z.object({url: z.url()}).strict();

/** How long the server has to hold still before a spec accepts that it has stopped reloading. */
const SETTLED_MILLISECONDS = 3_000;
const SETTLED_DEADLINE_MILLISECONDS = 60_000;
const INSTANCE_POLL_MILLISECONDS = 250;

/** The Worker instance now answering, or null while the server is between instances. */
async function probeServerInstance(request: APIRequestContext): Promise<string | null> {
	try {
		const response = await request.get("/api/__e2e__/instance");
		return response.status() === 200 ? instanceSchema.parse(await response.json()).instance_id : null;
	} catch {
		return null;
	}
}

/**
 * Block until the server has stopped restarting itself.
 *
 * `wrangler dev` watches the directory it serves the client from and reloads a tenth of a second
 * after the last write, sometimes twice. Each reload replaces the Worker instance: its in-memory
 * state goes, and any request in flight resolves as a 503 whose body is prose rather than JSON. A
 * spec that changed the served client owns those reloads, so it waits for them here instead of
 * leaving them to land on whichever spec runs next.
 *
 * This waits on the server's own account of itself rather than retrying a failed assertion, so a
 * regression that breaks a request still fails the spec that made it.
 */
export async function waitForServerToSettle(request: APIRequestContext): Promise<void> {
	const deadline = Date.now() + SETTLED_DEADLINE_MILLISECONDS;
	let instance = await probeServerInstance(request);
	let unchangedSince = Date.now();
	while (Date.now() - unchangedSince < SETTLED_MILLISECONDS) {
		if (Date.now() > deadline) {
			throw new Error("the browser test server never stopped reloading");
		}
		await new Promise<void>((resolveSleep) => {
			setTimeout(resolveSleep, INSTANCE_POLL_MILLISECONDS);
		});
		const current = await probeServerInstance(request);
		if (current === null || current !== instance) {
			instance = current;
			unchangedSince = Date.now();
		}
	}
}
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
