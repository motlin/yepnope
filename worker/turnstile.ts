import {z} from "zod";

// 🤖 Human verification for the signed-out authentication surface. The browser widget is only the
// visible half: a token proves nothing until Cloudflare's Siteverify redeems it here, before the
// Worker looks an account up, checks a password, mints a token, or asks the email service for
// anything. Nothing in this file records a token, an address, a cookie, an IP, or a Siteverify body
// — the only thing that ever leaves is one member of the closed `HumanVerificationOutcome` set.

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_MILLISECONDS = 10_000;
// Cloudflare documents tokens as at most 2048 characters, so anything longer is not worth a round trip.
const MAX_TOKEN_LENGTH = 2048;
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The browser sends the token in a header rather than the JSON body. Every public authentication
 * body in this Worker is parsed with a `.strict()` schema and forwarded to Better Auth untouched,
 * so a header keeps the gate entirely out of the payload contract.
 */
export const HUMAN_VERIFICATION_HEADER = "CF-Turnstile-Response";

/** Why a request was let through or turned away. This is the whole diagnostic vocabulary. */
export enum HumanVerificationOutcome {
	Accepted = "accepted",
	ActionMismatch = "action_mismatch",
	HostnameMismatch = "hostname_mismatch",
	MalformedToken = "malformed_token",
	MissingToken = "missing_token",
	Misconfigured = "misconfigured",
	RejectedChallenge = "rejected_challenge",
	SpentToken = "spent_token",
	Unavailable = "unavailable",
}

export interface HumanVerificationChallenge {
	/** The surfaces whose widget could legitimately have minted this token. */
	actions: readonly string[];
	remoteIp: string | null;
	token: string | null;
}

export type HumanVerificationVerifier = (challenge: HumanVerificationChallenge) => Promise<HumanVerificationOutcome>;

/**
 * The Siteverify transport, shaped like a Worker binding so a deployment can substitute one the way
 * `EMAIL` is substituted. Production never declares it and falls back to the global `fetch`.
 */
export interface TurnstileSiteverify {
	fetch: (request: Request) => Promise<Response>;
}

export interface TurnstileEnvironment {
	BETTER_AUTH_URL: string;
	TURNSTILE_SECRET_KEY?: string | undefined;
	TURNSTILE_SITEVERIFY?: TurnstileSiteverify | undefined;
	TURNSTILE_SITE_KEY?: string | undefined;
}

enum TurnstileMode {
	// Both keys are present: every protected surface must carry a redeemable token.
	Enforced = "enforced",
	// Neither key is present on a loopback deployment: local development runs without a widget.
	Disabled = "disabled",
	// Anything else, including a half-configured deployment. Protected surfaces fail closed.
	Misconfigured = "misconfigured",
}

interface TurnstileConfiguration {
	expectedHostname: string;
	mode: TurnstileMode;
	secretKey: string;
	siteKey: string;
}

function configuredKey(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

// 🔐 The expected hostname is the deployment's own canonical origin rather than a separate list, so
// a production Worker can never be talked into accepting a token minted for `localhost`.
function turnstileConfiguration(environment: TurnstileEnvironment): TurnstileConfiguration {
	const siteKey = configuredKey(environment.TURNSTILE_SITE_KEY);
	const secretKey = configuredKey(environment.TURNSTILE_SECRET_KEY);
	const expectedHostname = new URL(environment.BETTER_AUTH_URL).hostname;
	if (siteKey !== null && secretKey !== null) {
		return {expectedHostname, mode: TurnstileMode.Enforced, secretKey, siteKey};
	}
	const mode =
		siteKey === null && secretKey === null && LOOPBACK_HOSTNAMES.has(expectedHostname)
			? TurnstileMode.Disabled
			: TurnstileMode.Misconfigured;
	return {expectedHostname, mode, secretKey: "", siteKey: ""};
}

/**
 * The public site key, or null when this deployment renders no widget. The browser reads this so it
 * never draws a challenge the Worker would ignore, and never omits one the Worker would demand.
 */
export function turnstileSiteKey(environment: TurnstileEnvironment): string | null {
	const configuration = turnstileConfiguration(environment);
	return configuration.mode === TurnstileMode.Enforced ? configuration.siteKey : null;
}

const siteverifyResponseSchema = z.object({
	action: z.string().optional(),
	"error-codes": z.array(z.string()).optional(),
	hostname: z.string().optional(),
	success: z.boolean(),
});

// Documented Siteverify error codes, triaged by what the visitor should be told to do next. Every
// one of them produces the same reply; the distinction exists only for the operator's diagnostics.
const SITEVERIFY_ERROR_OUTCOMES: Readonly<Record<string, HumanVerificationOutcome>> = {
	"bad-request": HumanVerificationOutcome.Misconfigured,
	"internal-error": HumanVerificationOutcome.Unavailable,
	"invalid-input-response": HumanVerificationOutcome.RejectedChallenge,
	"invalid-input-secret": HumanVerificationOutcome.Misconfigured,
	"invalid-widget-id": HumanVerificationOutcome.Misconfigured,
	"missing-input-response": HumanVerificationOutcome.MissingToken,
	"missing-input-secret": HumanVerificationOutcome.Misconfigured,
	// One code covers both an expired token and a replayed one, because Siteverify redeems a token
	// exactly once and cannot afterwards tell the two apart.
	"timeout-or-duplicate": HumanVerificationOutcome.SpentToken,
};

function rejectionOutcome(errorCodes: readonly string[]): HumanVerificationOutcome {
	for (const code of errorCodes) {
		const outcome = SITEVERIFY_ERROR_OUTCOMES[code];
		if (outcome !== undefined) {
			return outcome;
		}
	}
	return HumanVerificationOutcome.RejectedChallenge;
}

function siteverifyRequest(configuration: TurnstileConfiguration, token: string, remoteIp: string | null): Request {
	const body = new URLSearchParams({response: token, secret: configuration.secretKey});
	// 🌐 The visitor's address goes to Cloudflare, which already terminated the connection, and
	// nowhere else. Turnstile treats it as an optional corroborating signal.
	if (remoteIp !== null) {
		body.set("remoteip", remoteIp);
	}
	return new Request(SITEVERIFY_URL, {
		body,
		headers: {"Content-Type": "application/x-www-form-urlencoded"},
		method: "POST",
		signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MILLISECONDS),
	});
}

/**
 * Redeems one token against Siteverify and decides whether the request may continue. Every failure
 * path — a missing token, an unreachable Siteverify, a body that is not the documented shape — ends
 * in a refusal, so a broken dependency closes the door rather than opening it.
 */
export function createTurnstileVerifier(environment: TurnstileEnvironment): HumanVerificationVerifier {
	const configuration = turnstileConfiguration(environment);
	const siteverify: TurnstileSiteverify = environment.TURNSTILE_SITEVERIFY ?? {
		fetch: async (request) => fetch(request),
	};
	return async (challenge) => {
		if (configuration.mode === TurnstileMode.Disabled) {
			return HumanVerificationOutcome.Accepted;
		}
		if (configuration.mode === TurnstileMode.Misconfigured) {
			return HumanVerificationOutcome.Misconfigured;
		}
		const token = challenge.token;
		if (token === null || token === "") {
			return HumanVerificationOutcome.MissingToken;
		}
		if (token.length > MAX_TOKEN_LENGTH) {
			return HumanVerificationOutcome.MalformedToken;
		}
		let parsed: z.infer<typeof siteverifyResponseSchema>;
		try {
			const response = await siteverify.fetch(siteverifyRequest(configuration, token, challenge.remoteIp));
			if (!response.ok) {
				return HumanVerificationOutcome.Unavailable;
			}
			const result = siteverifyResponseSchema.safeParse(await response.json());
			if (!result.success) {
				return HumanVerificationOutcome.Unavailable;
			}
			parsed = result.data;
		} catch {
			return HumanVerificationOutcome.Unavailable;
		}
		if (!parsed.success) {
			return rejectionOutcome(parsed["error-codes"] ?? []);
		}
		// 🎯 A token minted for one surface must not unlock another, and a token minted against a
		// different site must not unlock this one.
		if (parsed.action === undefined || !challenge.actions.includes(parsed.action)) {
			return HumanVerificationOutcome.ActionMismatch;
		}
		if (parsed.hostname !== configuration.expectedHostname) {
			return HumanVerificationOutcome.HostnameMismatch;
		}
		return HumanVerificationOutcome.Accepted;
	};
}
