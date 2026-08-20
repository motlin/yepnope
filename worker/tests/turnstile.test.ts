import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import {createAuthentication, type AuthenticationObservation} from "../auth";
import {createTestSiteverify, testTurnstileToken, TURNSTILE_TEST_KEYS} from "../turnstile-test-siteverify";
import {
	createTurnstileVerifier,
	HUMAN_VERIFICATION_HEADER,
	HumanVerificationOutcome,
	turnstileSiteKey,
	type TurnstileSiteverify,
} from "../turnstile";
import {API_ORIGIN} from "./helpers";

const PRODUCTION_HOSTNAME = new URL(API_ORIGIN).hostname;
const PASSWORD = "correct-horse-battery-staple";
const REFUSAL_BODY = {
	code: "HUMAN_VERIFICATION_REQUIRED",
	message: "Human verification did not complete. Complete the check on the page and try again.",
};

interface DeliveredEmail {
	subject: string;
	text: string;
}

interface Harness {
	handler: (request: Request) => Promise<Response>;
	mailbox: DeliveredEmail[];
	observations: AuthenticationObservation[];
}

/**
 * The real Worker stack — Better Auth and every middleware around it — over a Siteverify that
 * answers locally. Only the environment changes between cases, so what is under test is the gate
 * rather than a reimplementation of it.
 */
function harness(overrides: Partial<Env> = {}, siteverify: TurnstileSiteverify = createTestSiteverify()): Harness {
	const mailbox: DeliveredEmail[] = [];
	const observations: AuthenticationObservation[] = [];
	const environment: Env = {
		...env,
		TURNSTILE_SECRET_KEY: TURNSTILE_TEST_KEYS.alwaysPassesSecretKey,
		TURNSTILE_SITEVERIFY: siteverify,
		TURNSTILE_SITE_KEY: TURNSTILE_TEST_KEYS.alwaysPassesSiteKey,
		...overrides,
	};
	const authentication = createAuthentication(environment, {
		observe: (observation) => observations.push(observation),
		runInBackground: undefined,
		sendEmail: async (message) => {
			await Promise.resolve(mailbox.push({subject: message.subject, text: message.text ?? ""}));
		},
		verifyHuman: createTurnstileVerifier(environment),
	});
	return {handler: authentication.handler, mailbox, observations};
}

function post(path: string, body: Record<string, unknown>, token: string | null): Request {
	const headers = new Headers({"Content-Type": "application/json", Origin: API_ORIGIN});
	if (token !== null) {
		headers.set(HUMAN_VERIFICATION_HEADER, token);
	}
	return new Request(`${API_ORIGIN}/api/auth/${path}`, {body: JSON.stringify(body), headers, method: "POST"});
}

function passingToken(action: string, hostname = PRODUCTION_HOSTNAME): string {
	return testTurnstileToken({action, hostname});
}

function uniqueEmail(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}@example.com`;
}

async function refusalOf(response: Response): Promise<unknown> {
	return {
		body: await response.json(),
		cacheControl: response.headers.get("Cache-Control"),
		status: response.status,
	};
}

const REFUSED = {body: REFUSAL_BODY, cacheControl: "no-store", status: 403};

describe("Human verification configuration", () => {
	it("publishes the site key only when both halves of the pair are configured", () => {
		const configured = {
			...env,
			TURNSTILE_SECRET_KEY: TURNSTILE_TEST_KEYS.alwaysPassesSecretKey,
			TURNSTILE_SITE_KEY: TURNSTILE_TEST_KEYS.alwaysPassesSiteKey,
		};
		expect({
			blank: turnstileSiteKey({...configured, TURNSTILE_SITE_KEY: "   "}),
			configured: turnstileSiteKey(configured),
			secretOnly: turnstileSiteKey({...configured, TURNSTILE_SITE_KEY: undefined}),
			siteKeyOnly: turnstileSiteKey({...configured, TURNSTILE_SECRET_KEY: undefined}),
			unconfigured: turnstileSiteKey({BETTER_AUTH_URL: "http://localhost:5173"}),
		}).toStrictEqual({
			blank: null,
			configured: TURNSTILE_TEST_KEYS.alwaysPassesSiteKey,
			secretOnly: null,
			siteKeyOnly: null,
			unconfigured: null,
		});
	});

	// 🔓 Local development runs without a widget. That concession is spent entirely on loopback:
	// anywhere else, a missing key is a deployment mistake and the door stays shut.
	it("waives the check on a loopback origin and fails closed on any other unconfigured origin", async () => {
		const local = createTurnstileVerifier({BETTER_AUTH_URL: "http://localhost:5173"});
		const staging = createTurnstileVerifier({BETTER_AUTH_URL: "https://staging.yepnope.app"});
		const halfConfigured = createTurnstileVerifier({
			BETTER_AUTH_URL: "http://127.0.0.1:8787",
			TURNSTILE_SITE_KEY: TURNSTILE_TEST_KEYS.alwaysPassesSiteKey,
		});

		expect({
			halfConfigured: await halfConfigured({actions: ["sign_in"], remoteIp: null, token: null}),
			local: await local({actions: ["sign_in"], remoteIp: null, token: null}),
			staging: await staging({actions: ["sign_in"], remoteIp: null, token: null}),
		}).toStrictEqual({
			halfConfigured: HumanVerificationOutcome.Misconfigured,
			local: HumanVerificationOutcome.Accepted,
			staging: HumanVerificationOutcome.Misconfigured,
		});
	});
});

describe("Human verification of public authentication requests", () => {
	it("lets a redeemed token through to every protected surface", async () => {
		const {handler, mailbox} = harness();
		const email = uniqueEmail("verified-human");

		const registration = await handler(
			post("sign-up/email", {callbackURL: "/verify-email", email, password: PASSWORD}, passingToken("register")),
		);
		const verification = await handler(
			post("send-verification-email", {callbackURL: "/verify-email", email}, passingToken("verify_email")),
		);
		const recovery = await handler(
			post("request-password-reset", {email, redirectTo: "/reset-password"}, passingToken("reset_password")),
		);
		const magicLink = await handler(post("sign-in/magic-link", {callbackURL: "/", email}, passingToken("sign_in")));

		expect({
			delivered: mailbox.map((message) => message.subject),
			statuses: [registration.status, verification.status, recovery.status, magicLink.status],
		}).toStrictEqual({
			delivered: ["Verify your YepNope email", "Reset your YepNope password", "Sign in to YepNope"],
			statuses: [200, 200, 200, 200],
		});
	});

	it("refuses every protected surface when no token is presented", async () => {
		const {handler, mailbox} = harness();
		const email = uniqueEmail("tokenless");

		const refusals = [
			await handler(post("sign-up/email", {email, password: PASSWORD}, null)),
			await handler(post("sign-in/email", {email, password: PASSWORD}, null)),
			await handler(post("sign-in/magic-link", {callbackURL: "/", email}, null)),
			await handler(post("send-verification-email", {callbackURL: "/verify-email", email}, null)),
			await handler(post("request-password-reset", {email, redirectTo: "/reset-password"}, null)),
		];

		expect({
			delivered: mailbox.length,
			refusals: await Promise.all(refusals.map(refusalOf)),
		}).toStrictEqual({delivered: 0, refusals: [REFUSED, REFUSED, REFUSED, REFUSED, REFUSED]});
	});

	// 🛡️ The widget is decoration; this is the control. A script posting straight at the endpoint
	// gets exactly as far as a browser that never solved the challenge.
	it("refuses a direct request that forges or borrows a token", async () => {
		const {handler} = harness();
		const email = uniqueEmail("direct-api");

		const forged = await handler(post("sign-in/email", {email, password: PASSWORD}, "not-a-real-token"));
		const empty = await handler(post("sign-in/email", {email, password: PASSWORD}, ""));
		const oversized = await handler(post("sign-in/email", {email, password: PASSWORD}, "x".repeat(2049)));
		const otherSite = await handler(
			post("sign-in/email", {email, password: PASSWORD}, passingToken("sign_in", "attacker.example")),
		);

		expect(await Promise.all([forged, empty, oversized, otherSite].map(refusalOf))).toStrictEqual([
			REFUSED,
			REFUSED,
			REFUSED,
			REFUSED,
		]);
	});

	it("refuses a token minted for a different surface", async () => {
		const {handler, mailbox} = harness();
		const email = uniqueEmail("wrong-action");

		const recoveryWithSignInToken = await handler(
			post("request-password-reset", {email, redirectTo: "/reset-password"}, passingToken("sign_in")),
		);

		expect({delivered: mailbox.length, refusal: await refusalOf(recoveryWithSignInToken)}).toStrictEqual({
			delivered: 0,
			refusal: REFUSED,
		});
	});

	// The create-account page asks for the first verification message with the token it already
	// holds, rather than re-solving a challenge between two halves of one submission.
	it("accepts the create-account token for the verification message that follows it", async () => {
		const {handler, mailbox} = harness();
		const email = uniqueEmail("register-then-verify");

		await handler(
			post("sign-up/email", {callbackURL: "/verify-email", email, password: PASSWORD}, passingToken("register")),
		);
		const verification = await handler(
			post("send-verification-email", {callbackURL: "/verify-email", email}, passingToken("register")),
		);

		expect({delivered: mailbox.length, status: verification.status}).toStrictEqual({delivered: 1, status: 200});
	});

	it("redeems a token exactly once, so replaying it is refused", async () => {
		const {handler, mailbox} = harness();
		const email = uniqueEmail("replay");
		const token = passingToken("reset_password");

		const first = await handler(post("request-password-reset", {email, redirectTo: "/reset-password"}, token));
		const replayed = await handler(post("request-password-reset", {email, redirectTo: "/reset-password"}, token));

		expect({
			delivered: mailbox.length,
			first: first.status,
			replayed: await refusalOf(replayed),
		}).toStrictEqual({delivered: 0, first: 200, replayed: REFUSED});
	});

	it("refuses an expired token", async () => {
		const {handler} = harness();

		const expired = await handler(
			post(
				"sign-in/email",
				{email: uniqueEmail("expired"), password: PASSWORD},
				testTurnstileToken({action: "sign_in", expired: true, hostname: PRODUCTION_HOSTNAME}),
			),
		);

		expect(await refusalOf(expired)).toStrictEqual(REFUSED);
	});

	it("refuses a challenge Cloudflare itself declined", async () => {
		const {handler} = harness({TURNSTILE_SECRET_KEY: TURNSTILE_TEST_KEYS.alwaysFailsSecretKey});

		const declined = await handler(
			post("sign-in/email", {email: uniqueEmail("declined"), password: PASSWORD}, passingToken("sign_in")),
		);

		expect(await refusalOf(declined)).toStrictEqual(REFUSED);
	});

	// 🚪 An unreachable, slow, or nonsense Siteverify closes the door rather than opening it.
	it("fails closed when Siteverify cannot be reached or answers unusably", async () => {
		const unreachable = harness({}, {fetch: async () => Promise.reject(new Error("network is unreachable"))});
		const serverError = harness({}, {fetch: async () => Promise.resolve(new Response(null, {status: 502}))});
		const nonsense = harness({}, {fetch: async () => Promise.resolve(Response.json({ok: "maybe"}))});

		const responses = await Promise.all([
			unreachable.handler(
				post("sign-in/email", {email: "a@example.com", password: PASSWORD}, passingToken("sign_in")),
			),
			serverError.handler(
				post("sign-in/email", {email: "b@example.com", password: PASSWORD}, passingToken("sign_in")),
			),
			nonsense.handler(
				post("sign-in/email", {email: "c@example.com", password: PASSWORD}, passingToken("sign_in")),
			),
		]);

		expect(await Promise.all(responses.map(refusalOf))).toStrictEqual([REFUSED, REFUSED, REFUSED]);
	});

	it("leaves the completion endpoints that already carry a single-use credential alone", async () => {
		const {handler, mailbox} = harness();
		const email = uniqueEmail("emailed-link");
		await handler(
			post("sign-up/email", {callbackURL: "/verify-email", email, password: PASSWORD}, passingToken("register")),
		);
		await handler(post("send-verification-email", {callbackURL: "/verify-email", email}, passingToken("register")));
		const link = /https:\/\/\S+/.exec(mailbox[0]?.text ?? "")?.[0] ?? "";

		const completion = await handler(new Request(link));
		const session = await handler(new Request(`${API_ORIGIN}/api/auth/get-session`));

		expect({completion: completion.status, link: link !== "", session: session.status}).toStrictEqual({
			completion: 302,
			link: true,
			session: 200,
		});
	});
});

describe("Human verification diagnostics", () => {
	it("records the refusal reason and nothing that identifies the requester", async () => {
		const {handler, observations} = harness();
		const email = "diagnostics-alice@example.com";

		await handler(post("sign-in/email", {email, password: PASSWORD}, "forged-token-value"));
		await handler(post("sign-in/email", {email, password: PASSWORD}, passingToken("register")));

		const serialized = JSON.stringify(observations);
		expect({
			observations,
			revealsRequester:
				serialized.includes(email) ||
				serialized.includes(PASSWORD) ||
				serialized.includes("forged-token-value"),
		}).toStrictEqual({
			observations: [
				{
					event: "human_verification_evaluated",
					failure: null,
					level: "warn",
					reason: HumanVerificationOutcome.RejectedChallenge,
					status: null,
				},
				{
					event: "human_verification_evaluated",
					failure: null,
					level: "warn",
					reason: HumanVerificationOutcome.ActionMismatch,
					status: null,
				},
			],
			revealsRequester: false,
		});
	});

	it("says nothing at all about a check that was cleared", async () => {
		const {handler, observations} = harness();

		await handler(
			post(
				"request-password-reset",
				{email: uniqueEmail("quiet"), redirectTo: "/reset-password"},
				passingToken("reset_password"),
			),
		);

		expect(
			observations.filter((observation) => observation.event === "human_verification_evaluated"),
		).toStrictEqual([]);
	});

	// 🕵️ A refusal is identical whether or not the address exists, so the gate cannot be turned into
	// the account oracle the handler behind it takes such care to avoid being.
	it("refuses a known and an unknown address identically", async () => {
		const {handler} = harness();
		const known = uniqueEmail("known");
		await handler(
			post(
				"sign-up/email",
				{callbackURL: "/verify-email", email: known, password: PASSWORD},
				passingToken("register"),
			),
		);

		const knownRefusal = await handler(post("sign-in/email", {email: known, password: PASSWORD}, null));
		const unknownRefusal = await handler(
			post("sign-in/email", {email: uniqueEmail("unknown"), password: PASSWORD}, null),
		);

		expect(await refusalOf(knownRefusal)).toStrictEqual(await refusalOf(unknownRefusal));
	});
});
