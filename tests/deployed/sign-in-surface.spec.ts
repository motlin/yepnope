import {expect, test, type APIRequestContext, type Page} from "playwright/test";
import {z} from "zod";
import {DEPLOYMENT_ORIGIN_VARIABLE} from "../../scripts/deployment-check.ts";
import {PRODUCTION_HOSTNAME} from "../../scripts/preflight.ts";

/**
 * 🚪 The signed-out sign-in surface, on a real deployment, as far as a robot can take it.
 *
 * The README's "Verifying a deployment" asks for one pass per advertised method after each deploy.
 * Most of that pass is human by design: password sign-in and emailed links are Turnstile-gated,
 * the link itself lands in a real inbox, a passkey needs a real authenticator, and a provider
 * round trip needs a real consent screen. Nothing here weakens any of that. What this spec proves
 * instead is the share a person cannot easily see: that the deployment advertises every method it
 * should, draws every entry point it advertises, refuses the gated requests without a human token,
 * refuses to hand an automated browser that token, has a live client registered at each provider,
 * and issues passkey challenges for its own relying party. The human half is the README's
 * "Verifying a deployment" walk-through.
 */

const origin = (process.env[DEPLOYMENT_ORIGIN_VARIABLE] ?? `https://${PRODUCTION_HOSTNAME}`).replace(/\/$/, "");
const hostname = new URL(origin).hostname;

/** What production advertises; every `true` and every provider is a required pass. */
const PRODUCTION_SOCIAL_PROVIDERS = ["github", "google"] as const;

const AUTHORIZATION_HOSTS: Readonly<Record<string, string>> = {
	github: "github.com",
	google: "accounts.google.com",
};
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
	github: "GitHub",
	google: "Google",
};

/** How long Turnstile gets to refuse the automated browser before the spec calls it stuck. */
const TURNSTILE_VERDICT_MILLISECONDS = 60_000;

const authMethodsSchema = z
	.object({
		email_password: z.boolean(),
		magic_link: z.boolean(),
		passkey: z.boolean(),
		social: z.array(z.string()),
		turnstile_site_key: z.string().nullable(),
	})
	.strict();
type AuthMethods = z.infer<typeof authMethodsSchema>;

const gateRefusalSchema = z.object({code: z.literal("HUMAN_VERIFICATION_REQUIRED"), message: z.string()}).strict();
const socialRedirectSchema = z.object({url: z.url(), redirect: z.literal(true)}).strict();
const passkeyChallengeSchema = z.object({challenge: z.string().min(16), rpId: z.string()}).loose();

const browserHeaders = {Origin: origin, "Content-Type": "application/json"};

/** One slow request is a finding, not a five-minute wait. */
const REQUEST_TIMEOUT_MILLISECONDS = 30_000;

async function advertisedMethods(request: APIRequestContext): Promise<AuthMethods> {
	const response = await request.get(`${origin}/api/v1/auth-methods`, {timeout: REQUEST_TIMEOUT_MILLISECONDS});
	expect(response.status()).toBe(200);
	return authMethodsSchema.parse(await response.json());
}

function sessionCookieWasSet(headers: Record<string, string>): boolean {
	return Object.entries(headers).some(
		([name, value]) => name.toLowerCase() === "set-cookie" && value.includes("better-auth.session_token="),
	);
}

test("the deployment advertises every method the README requires", async ({request}) => {
	const methods = await advertisedMethods(request);
	if (hostname === PRODUCTION_HOSTNAME) {
		expect(methods.email_password).toBe(true);
		expect(methods.magic_link).toBe(true);
		expect(methods.passkey).toBe(true);
		expect([...methods.social].sort()).toEqual([...PRODUCTION_SOCIAL_PROVIDERS].sort());
		expect(methods.turnstile_site_key).not.toBeNull();
	}
	for (const provider of methods.social) {
		expect(AUTHORIZATION_HOSTS, `unknown provider ${provider}`).toHaveProperty(provider);
	}
});

test("password sign-in and emailed links refuse a request that carries no human token", async ({request}) => {
	const methods = await advertisedMethods(request);
	test.skip(methods.turnstile_site_key === null, "this deployment waived human verification");

	const attempts = [
		{path: "/api/auth/sign-in/email", data: {email: "nobody@example.com", password: "not-a-real-password"}},
		{path: "/api/auth/sign-in/magic-link", data: {email: "nobody@example.com", callbackURL: "/"}},
	];
	for (const attempt of attempts) {
		const response = await request.post(`${origin}${attempt.path}`, {
			data: attempt.data,
			headers: browserHeaders,
			timeout: REQUEST_TIMEOUT_MILLISECONDS,
		});
		expect(response.status(), attempt.path).toBe(403);
		expect(gateRefusalSchema.safeParse(await response.json()).success, attempt.path).toBe(true);
		expect(sessionCookieWasSet(response.headers()), attempt.path).toBe(false);
	}
});

test("each advertised provider has a live client that points back at this deployment", async ({request}) => {
	const methods = await advertisedMethods(request);
	for (const provider of methods.social) {
		const response = await request.post(`${origin}/api/auth/sign-in/social`, {
			data: {provider, callbackURL: "/", errorCallbackURL: "/sign-in"},
			headers: browserHeaders,
			timeout: REQUEST_TIMEOUT_MILLISECONDS,
		});
		expect(response.status(), provider).toBe(200);
		const redirect = new URL(socialRedirectSchema.parse(await response.json()).url);
		expect(redirect.hostname, provider).toBe(AUTHORIZATION_HOSTS[provider]);
		expect(redirect.searchParams.get("client_id"), provider).toBeTruthy();
		expect(redirect.searchParams.get("redirect_uri"), provider).toBe(`${origin}/api/auth/callback/${provider}`);
		expect(sessionCookieWasSet(response.headers()), provider).toBe(false);
	}
});

test("passkey sign-in challenges name this deployment as the relying party", async ({request}) => {
	const methods = await advertisedMethods(request);
	test.skip(!methods.passkey, "this deployment does not advertise passkeys");

	const response = await request.get(`${origin}/api/auth/passkey/generate-authenticate-options`, {
		headers: browserHeaders,
		timeout: REQUEST_TIMEOUT_MILLISECONDS,
	});
	expect(response.status()).toBe(200);
	const challenge = passkeyChallengeSchema.parse(await response.json());
	expect(challenge.rpId).toBe(hostname);
	expect(sessionCookieWasSet(response.headers())).toBe(false);
});

test("a forged emailed link creates no session", async ({request}) => {
	const methods = await advertisedMethods(request);
	test.skip(!methods.magic_link, "this deployment does not advertise emailed links");

	const forged = `${origin}/api/auth/magic-link/verify?token=${crypto.randomUUID()}&callbackURL=%2F`;
	const response = await request.get(forged, {maxRedirects: 0, timeout: REQUEST_TIMEOUT_MILLISECONDS});
	expect(response.status()).toBe(302);
	const landing = new URL(response.headers()["location"] ?? "", origin);
	expect(landing.origin).toBe(origin);
	expect(landing.searchParams.get("error")).toBeTruthy();
	expect(sessionCookieWasSet(response.headers())).toBe(false);
});

test("the sign-in page draws an entry point for every advertised method", async ({page, request}) => {
	const methods = await advertisedMethods(request);
	await page.goto(`${origin}/sign-in`);

	await expect(page.getByRole("textbox", {name: "Email"})).toBeVisible();
	await expect(page.getByLabel("Password")).toBeVisible({visible: methods.email_password});
	await expect(page.getByRole("button", {name: "Email me a sign-in link"})).toBeVisible({
		visible: methods.magic_link,
	});
	await expect(page.getByRole("button", {name: "Sign in with a passkey"})).toBeVisible({visible: methods.passkey});
	for (const provider of methods.social) {
		await expect(page.getByRole("button", {name: `Continue with ${PROVIDER_LABELS[provider]}`})).toBeVisible();
	}
	await expect(page.getByRole("group", {name: "Human verification"})).toBeVisible({
		visible: methods.turnstile_site_key !== null,
	});
});

async function verificationStatus(page: Page): Promise<string> {
	const group = page.getByRole("group", {name: "Human verification"});
	return (await group.locator("p").first().textContent()) ?? "";
}

test("Turnstile never hands this automated browser a token", async ({page, request}) => {
	const methods = await advertisedMethods(request);
	test.skip(methods.turnstile_site_key === null, "this deployment waived human verification");
	test.setTimeout(TURNSTILE_VERDICT_MILLISECONDS + 60_000);

	await page.goto(`${origin}/sign-in`);
	const deadline = Date.now() + TURNSTILE_VERDICT_MILLISECONDS;
	let status = await verificationStatus(page);
	while (Date.now() < deadline && !status.includes("could not verify")) {
		expect(status, "the widget minted a token for an automated browser").not.toContain("complete");
		await page.waitForTimeout(1_000);
		status = await verificationStatus(page);
	}
	expect(status).not.toContain("complete");
});
