import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import {createAuthentication, type AuthenticationObservation} from "../auth";
import {API_ORIGIN, cookieFrom, createVerifiedBrowserSession, emailLink, required} from "./helpers";

interface DeliveredEmail {
	subject: string;
	text: string;
	to: string;
}

interface Harness {
	authentication: ReturnType<typeof createAuthentication>;
	mailbox: DeliveredEmail[];
	observations: AuthenticationObservation[];
}

const GITHUB_CREDENTIALS = {GITHUB_CLIENT_ID: "github-client", GITHUB_CLIENT_SECRET: "github-secret"};
const GOOGLE_CREDENTIALS = {GOOGLE_CLIENT_ID: "google-client", GOOGLE_CLIENT_SECRET: "google-secret"};

function harness(overrides: Partial<Env> = {}): Harness {
	const mailbox: DeliveredEmail[] = [];
	const observations: AuthenticationObservation[] = [];
	const authentication = createAuthentication(
		{...env, ...overrides},
		{
			observe: (observation) => observations.push(observation),
			runInBackground: undefined,
			sendEmail: async (message) => {
				await Promise.resolve(
					mailbox.push({
						subject: message.subject,
						text: required(message.text, "email text body"),
						to: typeof message.to === "string" ? message.to : JSON.stringify(message.to),
					}),
				);
			},
		},
	);
	return {authentication, mailbox, observations};
}

function post(path: string, body: Record<string, unknown>, cookie?: string): Request {
	const headers = new Headers({"Content-Type": "application/json", Origin: API_ORIGIN});
	if (cookie !== undefined) {
		headers.set("Cookie", cookie);
	}
	return new Request(`${API_ORIGIN}/api/auth/${path}`, {method: "POST", headers, body: JSON.stringify(body)});
}

function get(path: string, cookie?: string): Request {
	return new Request(`${API_ORIGIN}/api/auth/${path}`, {
		headers: cookie === undefined ? {Origin: API_ORIGIN} : {Cookie: cookie, Origin: API_ORIGIN},
	});
}

async function sessionUserId(authentication: Harness["authentication"], cookie: string): Promise<string> {
	const response = await authentication.handler(get("get-session", cookie));
	expect(response.status).toBe(200);
	const body = await response.json<{user: {emailVerified: boolean; id: string}} | null>();
	expect(body?.user.emailVerified).toBe(true);
	return required(body?.user.id, "session user id");
}

function uniqueEmail(): string {
	return `magic-${crypto.randomUUID()}@example.com`;
}

describe("Passwordless email sign-in", () => {
	it("creates a verified session from an emailed link", async () => {
		const {authentication, mailbox} = harness();
		const email = uniqueEmail();

		const requested = await authentication.handler(post("sign-in/magic-link", {callbackURL: "/", email}));

		expect(requested.status).toBe(200);
		expect(await requested.json()).toStrictEqual({
			message: "If the request can be completed, check your inbox for next steps.",
			status: true,
		});
		const delivered = required(mailbox[0], "magic link email");
		expect(delivered.subject).toBe("Sign in to YepNope");
		expect(delivered.to).toBe(email);
		expect(delivered.text).toContain("This link expires in 15 minutes.");

		const followed = await authentication.handler(new Request(emailLink(delivered)));

		expect(followed.status).toBe(302);
		await expect(sessionUserId(authentication, cookieFrom(followed))).resolves.toEqual(expect.any(String));
	});

	it("never persists a usable magic-link token", async () => {
		const {authentication, mailbox} = harness();

		await authentication.handler(post("sign-in/magic-link", {callbackURL: "/", email: uniqueEmail()}));

		const token = required(
			new URL(emailLink(required(mailbox[0], "magic link email"))).searchParams.get("token") ?? undefined,
			"magic link token",
		);
		const stored = await env.DB.prepare("SELECT identifier, value FROM verification").all<{
			identifier: string;
			value: string;
		}>();
		expect(stored.results.some((row) => row.identifier.includes(token) || row.value.includes(token))).toBe(false);
	});

	it("signs into the existing account rather than creating a duplicate email", async () => {
		const email = `magic-existing-${crypto.randomUUID()}@example.com`;
		const existing = await createVerifiedBrowserSession(email);
		const {authentication, mailbox} = harness();

		await authentication.handler(post("sign-in/magic-link", {callbackURL: "/", email}));
		const followed = await authentication.handler(new Request(emailLink(required(mailbox[0], "magic link email"))));

		expect(followed.status).toBe(302);
		await expect(sessionUserId(authentication, cookieFrom(followed))).resolves.toBe(existing.userId);
		const accounts = await env.DB.prepare("SELECT COUNT(*) AS total FROM user WHERE email = ?")
			.bind(email)
			.first<{total: number}>();
		expect(accounts?.total).toBe(1);
	});

	it("answers identically whether or not the address has an account", async () => {
		const known = `magic-known-${crypto.randomUUID()}@example.com`;
		await createVerifiedBrowserSession(known);
		const {authentication} = harness();

		const forKnown = await authentication.handler(post("sign-in/magic-link", {callbackURL: "/", email: known}));
		const forUnknown = await authentication.handler(
			post("sign-in/magic-link", {callbackURL: "/", email: uniqueEmail()}),
		);

		expect(forKnown.status).toBe(forUnknown.status);
		expect(await forKnown.json()).toStrictEqual(await forUnknown.json());
	});
});

describe("Passkeys", () => {
	it("refuses to mint registration options without a session", async () => {
		const {authentication} = harness();

		const response = await authentication.handler(get("passkey/generate-register-options"));

		expect(response.status).toBe(401);
	});

	it("binds registration options to the deployment relying party", async () => {
		const {cookie} = await createVerifiedBrowserSession();
		const {authentication} = harness();

		const response = await authentication.handler(get("passkey/generate-register-options", cookie));

		expect(response.status).toBe(200);
		const options = await response.json<{
			challenge: string;
			rp: {id: string; name: string};
			user: {name: string};
		}>();
		expect(options.rp).toStrictEqual({id: "yepnope.app", name: "YepNope"});
		expect(options.challenge.length).toBeGreaterThan(0);
	});

	it("offers usernameless authentication options to signed-out visitors", async () => {
		const {authentication} = harness();

		const response = await authentication.handler(get("passkey/generate-authenticate-options"));

		expect(response.status).toBe(200);
		const options = await response.json<{challenge: string; rpId: string}>();
		expect(options.rpId).toBe("yepnope.app");
		expect(options.challenge.length).toBeGreaterThan(0);
	});

	it("erases registered passkeys along with the account", async () => {
		const {cookie, userId} = await createVerifiedBrowserSession();
		const {authentication} = harness();
		await env.DB.prepare(
			"INSERT INTO passkey (id, name, public_key, user_id, credential_id, counter, device_type, backed_up) " +
				"VALUES (?, 'Alice phone', 'public-key', ?, ?, 0, 'singleDevice', 0)",
		)
			.bind(`passkey-${userId}`, userId, `credential-${userId}`)
			.run();
		expect(
			await env.DB.prepare("SELECT COUNT(*) AS total FROM passkey WHERE user_id = ?")
				.bind(userId)
				.first<{total: number}>(),
		).toStrictEqual({total: 1});

		const deleted = await authentication.handler(
			post("delete-user", {password: "correct-horse-battery-staple"}, cookie),
		);
		expect(deleted.status).toBe(200);

		const remaining = await env.DB.prepare("SELECT COUNT(*) AS total FROM passkey WHERE user_id = ?")
			.bind(userId)
			.first<{total: number}>();
		expect(remaining?.total).toBe(0);
	});

	it("starts every account with no registered passkeys", async () => {
		const {cookie} = await createVerifiedBrowserSession();
		const {authentication} = harness();

		const response = await authentication.handler(get("passkey/list-user-passkeys", cookie));

		expect(response.status).toBe(200);
		expect(await response.json()).toStrictEqual([]);
	});
});

describe("Social sign-in", () => {
	it("rejects a provider this deployment has no credentials for", async () => {
		const {authentication} = harness();

		const response = await authentication.handler(post("sign-in/social", {callbackURL: "/", provider: "github"}));

		expect(response.status).toBeGreaterThanOrEqual(400);
	});

	it("hands the browser a GitHub authorization URL once GitHub is configured", async () => {
		const {authentication} = harness(GITHUB_CREDENTIALS);

		const response = await authentication.handler(post("sign-in/social", {callbackURL: "/", provider: "github"}));

		expect(response.status).toBe(200);
		const {url} = await response.json<{url: string}>();
		const authorize = new URL(url);
		expect(`${authorize.origin}${authorize.pathname}`).toBe("https://github.com/login/oauth/authorize");
		expect(authorize.searchParams.get("client_id")).toBe(GITHUB_CREDENTIALS.GITHUB_CLIENT_ID);
		expect(authorize.searchParams.get("redirect_uri")).toBe(`${API_ORIGIN}/api/auth/callback/github`);
		expect(authorize.searchParams.get("state")).not.toBeNull();
	});

	it("hands the browser a Google authorization URL once Google is configured", async () => {
		const {authentication} = harness(GOOGLE_CREDENTIALS);

		const response = await authentication.handler(post("sign-in/social", {callbackURL: "/", provider: "google"}));

		expect(response.status).toBe(200);
		const {url} = await response.json<{url: string}>();
		const authorize = new URL(url);
		expect(authorize.origin).toBe("https://accounts.google.com");
		expect(authorize.searchParams.get("client_id")).toBe(GOOGLE_CREDENTIALS.GOOGLE_CLIENT_ID);
		expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
	});
});

describe("Authentication telemetry", () => {
	it("records which mechanism completed without recording who used it", async () => {
		const {authentication, mailbox, observations} = harness();
		const email = uniqueEmail();

		await authentication.handler(post("sign-in/magic-link", {callbackURL: "/", email}));
		await authentication.handler(new Request(emailLink(required(mailbox[0], "magic link email"))));

		expect(observations).toStrictEqual([
			{
				event: "authentication_email_delivered",
				failure: null,
				level: "info",
				reason: "request_magic_link",
				status: null,
			},
			{
				event: "public_authentication_response_normalized",
				failure: null,
				level: "info",
				reason: "request_magic_link",
				status: 200,
			},
			{
				event: "authentication_method_completed",
				failure: null,
				level: "info",
				reason: "magic_link",
				status: 302,
			},
		]);
		const serialized = JSON.stringify(observations);
		expect(serialized).not.toContain(email);
		expect(serialized).not.toContain(email.split("@")[0]);
	});
});
