import {mcp} from "@better-auth/mcp";
import {drizzleAdapter} from "@better-auth/drizzle-adapter";
import {oauthDeviceAuthorization} from "@better-auth/oauth-provider";
import {betterAuth} from "better-auth";
import {jwt, magicLink} from "better-auth/plugins";
import {drizzle} from "drizzle-orm/d1";
import {AsyncLocalStorage} from "node:async_hooks";
import {z} from "zod";
import {
	accounts,
	deviceCodes,
	jsonWebKeys,
	oauthAccessTokens,
	oauthClientAssertions,
	oauthClientResources,
	oauthClients,
	oauthConsents,
	oauthRefreshTokens,
	oauthResources,
	passkeys,
	sessions,
	users,
	verifications,
} from "./db/d1-schema";
import {deleteAccountDurableObject, markAccountDeletionRequested, recordAccountIdentity} from "./identity-lifecycle";
import {
	createTurnstileVerifier,
	HUMAN_VERIFICATION_HEADER,
	HumanVerificationOutcome,
	type HumanVerificationVerifier,
} from "./turnstile";

const AUTHENTICATION_PATH = "/api/auth";
const PASSKEY_PATH_PREFIX = `${AUTHENTICATION_PATH}/passkey/`;
const EMAIL_REGISTRATION_PATH = `${AUTHENTICATION_PATH}/sign-up/email`;
const EMAIL_SIGN_IN_PATH = `${AUTHENTICATION_PATH}/sign-in/email`;
const MAGIC_LINK_SIGN_IN_PATH = `${AUTHENTICATION_PATH}/sign-in/magic-link`;
const EMAIL_VERIFICATION_REQUEST_PATH = `${AUTHENTICATION_PATH}/send-verification-email`;
const EMAIL_VERIFICATION_PATH = `${AUTHENTICATION_PATH}/verify-email`;
const EMAIL_VERIFICATION_IDENTIFIER_PREFIX = "yepnope-email-verification:";
const PASSWORD_RECOVERY_REQUEST_PATH = `${AUTHENTICATION_PATH}/request-password-reset`;
const PUBLIC_AUTHENTICATION_RESPONSE_FLOOR_MILLISECONDS = 500;
const AUTHENTICATION_TOKEN_EXPIRY_SECONDS = 60 * 60;
const MAGIC_LINK_EXPIRY_SECONDS = 15 * 60;
const MAGIC_LINK_RATE_LIMIT = {window: 60, max: 5} as const;
const OAUTH_ACCESS_TOKEN_EXPIRY_SECONDS = 10 * 60;
const OAUTH_AUTHORIZATION_CODE_EXPIRY_SECONDS = 5 * 60;
const OAUTH_REFRESH_TOKEN_EXPIRY_SECONDS = 30 * 24 * 60 * 60;
export const MCP_RESOURCE_PATH = "/mcp";
const OAUTH_CONSENT_PATH = "/oauth/consent";
export const OAUTH_SCOPES = ["openid", "offline_access", "yepnope:questions"] as const;
const OAUTH_SCOPE_SET: ReadonlySet<string> = new Set(OAUTH_SCOPES);
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEVICE_AUTHORIZATION_PATH = "/device";
// 📟 A device code is approved by a human reading it off a terminal, so it is short-lived and its
// polling floor is generous: the hook's login is a one-off, not a hot path.
const DEVICE_CODE_EXPIRY = "10m";
const DEVICE_CODE_POLLING_INTERVAL = "5s";
const emailRegistrationSchema = z
	.object({
		callbackURL: z.string().optional(),
		email: z.email(),
		password: z.string().min(8).max(128),
		rememberMe: z.boolean().optional(),
	})
	.strict();
const emailSignInSchema = z
	.object({
		callbackURL: z.string().optional(),
		email: z.email(),
		oauth_query: z.string().optional(),
		password: z.string(),
		rememberMe: z.boolean().optional(),
	})
	.strict();
const magicLinkSignInSchema = z
	.object({
		callbackURL: z.string().optional(),
		email: z.email(),
		name: z.string().optional(),
		newUserCallbackURL: z.string().optional(),
		errorCallbackURL: z.string().optional(),
	})
	.strict();
const emailVerificationRequestSchema = z
	.object({
		callbackURL: z.string().optional(),
		email: z.email(),
	})
	.strict();
const passwordRecoveryRequestSchema = z
	.object({
		email: z.email(),
		redirectTo: z.string().optional(),
	})
	.strict();
// 📝 RFC 7591 §2 lets an authorization server ignore registration metadata it does not understand,
// so this schema is not strict: a member YepNope has no opinion about — `jwks_uri`, `subject_type`,
// whatever the next client invents — is stripped rather than turned into a refusal. Every member
// listed here is still checked, and the parsed result, never the caller's body, reaches Better Auth.
const dynamicClientRegistrationSchema = z.object({
	application_type: z.literal("native").optional(),
	client_name: z.string().trim().min(1).max(120).optional(),
	client_uri: z.url().optional(),
	contacts: z.array(z.email()).max(5).optional(),
	grant_types: z
		.array(z.enum(["authorization_code", "refresh_token", DEVICE_CODE_GRANT_TYPE]))
		.min(1)
		.max(2),
	logo_uri: z.url().optional(),
	policy_uri: z.url().optional(),
	redirect_uris: z.array(z.url()).min(1).max(8).optional(),
	resources: z.array(z.string()).max(1).optional(),
	response_types: z.tuple([z.literal("code")]).optional(),
	scope: z.string().optional(),
	software_id: z.string().trim().min(1).max(120).optional(),
	software_version: z.string().trim().min(1).max(60).optional(),
	token_endpoint_auth_method: z.literal("none"),
	tos_uri: z.url().optional(),
});

type DynamicClientRegistration = z.infer<typeof dynamicClientRegistrationSchema>;

function invalidRegistrationMembers(error: z.ZodError): string {
	const members = [
		...new Set(
			error.issues.map((issue) => (typeof issue.path[0] === "string" ? issue.path[0] : "the request body")),
		),
	].sort();
	return members.length === 1 ? `${members[0]} is invalid` : `${members.join(", ")} are invalid`;
}

/**
 * Two client shapes are registrable and nothing else. A browser-redirect client keeps the loopback
 * authorization-code flow it always had; a device client has no browser at all, so it must not carry
 * a redirect URI or a response type it could never use. A refusal names the member that caused it,
 * because a client author reading a bare "not permitted" has to guess which field offended.
 */
function impermissibleRegistrationMember(registration: DynamicClientRegistration, resource: string): string | null {
	if (registration.grant_types.includes(DEVICE_CODE_GRANT_TYPE)) {
		if (registration.grant_types.includes("authorization_code")) {
			return "grant_types cannot combine the device code grant with authorization_code";
		}
		if (registration.redirect_uris !== undefined) {
			return "redirect_uris is not permitted for a device code client";
		}
		if (registration.response_types !== undefined) {
			return "response_types is not permitted for a device code client";
		}
	} else {
		if (!registration.grant_types.includes("authorization_code")) {
			return "grant_types must include authorization_code";
		}
		if (registration.response_types === undefined) {
			return 'response_types must be ["code"]';
		}
		if (registration.redirect_uris === undefined) {
			return "redirect_uris is required for an authorization_code client";
		}
		if (!registration.redirect_uris.every(isLoopbackRedirectUri)) {
			return "redirect_uris must each be an http loopback URL";
		}
	}
	if (!hasExactOAuthScopes(registration.scope)) {
		return `scope may request only: ${OAUTH_SCOPES.join(" ")}`;
	}
	if (
		registration.resources !== undefined &&
		(registration.resources.length !== 1 || registration.resources[0] !== resource)
	) {
		return `resources may name only ${resource}`;
	}
	return null;
}

const authenticationSchema = {
	account: accounts,
	deviceCode: deviceCodes,
	jwks: jsonWebKeys,
	oauthAccessToken: oauthAccessTokens,
	oauthClient: oauthClients,
	oauthClientAssertion: oauthClientAssertions,
	oauthClientResource: oauthClientResources,
	oauthConsent: oauthConsents,
	oauthRefreshToken: oauthRefreshTokens,
	oauthResource: oauthResources,
	passkey: passkeys,
	session: sessions,
	user: users,
	verification: verifications,
};

type AuthenticationEnvironment = Pick<
	Env,
	| "AUTH_EMAIL_FROM"
	| "BETTER_AUTH_SECRET"
	| "BETTER_AUTH_URL"
	| "DB"
	| "GITHUB_CLIENT_ID"
	| "GITHUB_CLIENT_SECRET"
	| "GOOGLE_CLIENT_ID"
	| "GOOGLE_CLIENT_SECRET"
	| "USER_DO"
>;

// 🔌 Social providers are configuration, not code: a provider appears only once both of its
// secrets are set, so a deploy without credentials simply never advertises or accepts it.
const SOCIAL_PROVIDERS = ["github", "google"] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

interface SocialProviderCredentials {
	clientId: string;
	clientSecret: string;
}

const SOCIAL_PROVIDER_CREDENTIAL_NAMES: Readonly<
	Record<SocialProvider, {id: keyof AuthenticationEnvironment; secret: keyof AuthenticationEnvironment}>
> = {
	github: {id: "GITHUB_CLIENT_ID", secret: "GITHUB_CLIENT_SECRET"},
	google: {id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET"},
};

export interface AuthenticationMethods {
	emailPassword: boolean;
	magicLink: boolean;
	passkey: boolean;
	social: SocialProvider[];
}

function configuredSecret(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function socialProviderCredentials(
	environment: AuthenticationEnvironment,
): Partial<Record<SocialProvider, SocialProviderCredentials>> {
	const credentials: Partial<Record<SocialProvider, SocialProviderCredentials>> = {};
	for (const provider of SOCIAL_PROVIDERS) {
		const names = SOCIAL_PROVIDER_CREDENTIAL_NAMES[provider];
		const clientId = configuredSecret(environment[names.id]);
		const clientSecret = configuredSecret(environment[names.secret]);
		if (clientId !== null && clientSecret !== null) {
			credentials[provider] = {clientId, clientSecret};
		}
	}
	return credentials;
}

/**
 * The sign-in methods this deployment can actually complete. The browser reads this so it never
 * renders a provider button that would dead-end on a missing secret.
 */
export function authenticationMethods(environment: AuthenticationEnvironment): AuthenticationMethods {
	const credentials = socialProviderCredentials(environment);
	return {
		emailPassword: true,
		magicLink: true,
		passkey: true,
		social: SOCIAL_PROVIDERS.filter((provider) => credentials[provider] !== undefined),
	};
}
type AuthenticationEmail = Parameters<SendEmail["send"]>[0];

interface AuthenticationEmailCopy {
	actionLabel: string;
	expiry: string;
	introduction: string;
	preheader: string;
	subject: string;
}

export interface AuthenticationDependencies {
	observe: (observation: AuthenticationObservation) => void;
	publicAuthenticationTiming: {
		currentMilliseconds: () => number;
		wait: (milliseconds: number) => Promise<void>;
	};
	runInBackground: ((promise: Promise<unknown>) => void) | undefined;
	sendEmail: (message: AuthenticationEmail) => Promise<void>;
	verifyHuman: HumanVerificationVerifier;
}

/**
 * A wrapper around the Better Auth handler. `createAuthentication` composes an ordered list of
 * these so the request path reads as a list rather than a pyramid of nested callbacks.
 */
type AuthenticationHandler = (request: Request) => Promise<Response>;
type AuthenticationMiddleware = (next: AuthenticationHandler) => AuthenticationHandler;

function composeAuthenticationMiddleware(
	middleware: readonly AuthenticationMiddleware[],
	handler: AuthenticationHandler,
): AuthenticationHandler {
	return middleware.reduceRight((next, wrap) => wrap(next), handler);
}

export interface AuthenticationObservation {
	event:
		| "access_token_rejected"
		| "authentication_email_delivered"
		| "authentication_email_delivery_failed"
		| "authentication_email_delivery_retried"
		| "authentication_library_log"
		| "authentication_method_completed"
		| "authentication_verification_state_classified"
		| "human_verification_evaluated"
		| "public_authentication_response_normalized";
	failure: AuthenticationEmailFailure | null;
	level: "debug" | "error" | "info" | "warn";
	reason: string;
	status: number | null;
}

// 📮 Why a message did not leave the Worker, drawn from a closed vocabulary. Cloudflare Email
// Service rejections carry the recipient address and the signed link in `message`, so only the
// class derived from the documented `code` is ever recorded.
enum AuthenticationEmailFailure {
	// The message itself can never be accepted: malformed fields, oversized body, bad headers.
	MessageRejected = "message_rejected",
	// This recipient will keep being refused. Until a sending domain is onboarded to Email Service,
	// Cloudflare accepts only addresses already verified in the account, which strands every
	// genuinely new sign-up while the operator's own address keeps working.
	RecipientRejected = "recipient_rejected",
	SenderRejected = "sender_rejected",
	Throttled = "throttled",
	Transient = "transient",
}

const AUTHENTICATION_EMAIL_DELIVERY_ATTEMPTS = 3;

/** Cloudflare Email Service error codes, triaged by whether another attempt could change anything. */
const AUTHENTICATION_EMAIL_FAILURE_CODES: Readonly<Record<string, AuthenticationEmailFailure>> = {
	E_CONTENT_TOO_LARGE: AuthenticationEmailFailure.MessageRejected,
	E_DAILY_LIMIT_EXCEEDED: AuthenticationEmailFailure.Throttled,
	E_DELIVERY_FAILED: AuthenticationEmailFailure.Transient,
	E_FIELD_MISSING: AuthenticationEmailFailure.MessageRejected,
	E_HEADERS_TOO_LARGE: AuthenticationEmailFailure.MessageRejected,
	E_HEADERS_TOO_MANY: AuthenticationEmailFailure.MessageRejected,
	E_HEADER_NAME_INVALID: AuthenticationEmailFailure.MessageRejected,
	E_HEADER_NOT_ALLOWED: AuthenticationEmailFailure.MessageRejected,
	E_HEADER_USE_API_FIELD: AuthenticationEmailFailure.MessageRejected,
	E_HEADER_VALUE_INVALID: AuthenticationEmailFailure.MessageRejected,
	E_HEADER_VALUE_TOO_LONG: AuthenticationEmailFailure.MessageRejected,
	E_INTERNAL_SERVER_ERROR: AuthenticationEmailFailure.Transient,
	E_RATE_LIMIT_EXCEEDED: AuthenticationEmailFailure.Throttled,
	E_RECIPIENT_NOT_ALLOWED: AuthenticationEmailFailure.RecipientRejected,
	E_RECIPIENT_SUPPRESSED: AuthenticationEmailFailure.RecipientRejected,
	E_SENDER_DOMAIN_NOT_AVAILABLE: AuthenticationEmailFailure.SenderRejected,
	E_SENDER_NOT_VERIFIED: AuthenticationEmailFailure.SenderRejected,
	E_TOO_MANY_ATTACHMENTS: AuthenticationEmailFailure.MessageRejected,
	E_TOO_MANY_RECIPIENTS: AuthenticationEmailFailure.MessageRejected,
	E_VALIDATION_ERROR: AuthenticationEmailFailure.MessageRejected,
};

const authenticationEmailErrorSchema = z.object({code: z.string()});

/** Anything without a documented code is treated as a blip worth one more attempt. */
function classifyAuthenticationEmailFailure(caught: unknown): AuthenticationEmailFailure {
	const parsed = authenticationEmailErrorSchema.safeParse(caught);
	if (!parsed.success) {
		return AuthenticationEmailFailure.Transient;
	}
	return AUTHENTICATION_EMAIL_FAILURE_CODES[parsed.data.code] ?? AuthenticationEmailFailure.Transient;
}

/**
 * Hands one already-minted message to the email service, retrying only failures a retry could fix.
 * Retries reuse the same message, so the account never gains a second usable token from one request.
 */
async function deliverAuthenticationEmail(
	dependencies: AuthenticationDependencies,
	message: AuthenticationEmail,
	reason: PublicAuthenticationOperation,
): Promise<void> {
	for (let attempt = 1; attempt <= AUTHENTICATION_EMAIL_DELIVERY_ATTEMPTS; attempt += 1) {
		try {
			await dependencies.sendEmail(message);
			dependencies.observe({
				event: "authentication_email_delivered",
				failure: null,
				level: "info",
				reason,
				status: null,
			});
			return;
		} catch (caught) {
			const failure = classifyAuthenticationEmailFailure(caught);
			const retrying =
				failure === AuthenticationEmailFailure.Transient && attempt < AUTHENTICATION_EMAIL_DELIVERY_ATTEMPTS;
			dependencies.observe({
				event: retrying ? "authentication_email_delivery_retried" : "authentication_email_delivery_failed",
				failure,
				level: retrying ? "warn" : "error",
				reason,
				status: null,
			});
			if (!retrying) {
				return;
			}
		}
	}
}

/**
 * Delivery never decides the response. Where the platform offers one, the send moves to a background
 * task so a slow or retried delivery cannot turn response latency into an account-state oracle.
 */
async function sendAuthenticationEmail(
	dependencies: AuthenticationDependencies,
	message: AuthenticationEmail,
	reason: PublicAuthenticationOperation,
): Promise<void> {
	const delivery = deliverAuthenticationEmail(dependencies, message, reason);
	if (dependencies.runInBackground === undefined) {
		await delivery;
		return;
	}
	dependencies.runInBackground(delivery);
}

// 🤖 The surfaces a signed-out visitor can reach, and the widget action each one's token must carry.
// A token minted for one surface cannot unlock another. Two paths accept either of two surfaces,
// both for the same reason: a page that offers two ways to ask for mail solves one challenge, not
// one per button. The create-account page asks for the first verification message with the token it
// already holds, and the recovery page offers the emailed sign-in link beside the password form.
const HUMAN_VERIFICATION_ACTIONS: ReadonlyMap<string, readonly string[]> = new Map([
	[EMAIL_REGISTRATION_PATH, ["register"]],
	[EMAIL_SIGN_IN_PATH, ["sign_in"]],
	[EMAIL_VERIFICATION_REQUEST_PATH, ["register", "verify_email"]],
	[MAGIC_LINK_SIGN_IN_PATH, ["reset_password", "sign_in"]],
	[PASSWORD_RECOVERY_REQUEST_PATH, ["reset_password"]],
]);

// One reply for every refusal. The visitor learns that the check has to be redone and nothing else:
// not whether the address exists, not which of the nine outcomes fired.
const HUMAN_VERIFICATION_FAILURE_BODY = {
	code: "HUMAN_VERIFICATION_REQUIRED",
	message: "Human verification did not complete. Complete the check on the page and try again.",
} as const;

/**
 * The outermost gate. It runs before Better Auth sees the request, so a visitor who cannot redeem a
 * token never causes an account lookup, a password comparison, a token mint, or an email send. It
 * supplements the per-requester and per-destination limits underneath it rather than replacing any
 * of them: a redeemed token still lands in the same magic-link window and the same delivery retry
 * budget it always did.
 */
function humanVerificationAuthenticationHandler(
	verifyHuman: HumanVerificationVerifier,
	observe: AuthenticationDependencies["observe"],
): AuthenticationMiddleware {
	return (next) => async (request) => {
		if (request.method !== "POST") {
			return next(request);
		}
		const actions = HUMAN_VERIFICATION_ACTIONS.get(new URL(request.url).pathname);
		if (actions === undefined) {
			return next(request);
		}
		const outcome = await verifyHuman({
			actions,
			remoteIp: request.headers.get("CF-Connecting-IP"),
			token: request.headers.get(HUMAN_VERIFICATION_HEADER),
		});
		if (outcome === HumanVerificationOutcome.Accepted) {
			// Solve volume is already Cloudflare's own analytics to report. The Worker log exists to
			// explain refusals, so a cleared check leaves no trace beyond the request it allowed.
			return next(request);
		}
		observe({
			event: "human_verification_evaluated",
			failure: null,
			level: outcome === HumanVerificationOutcome.Misconfigured ? "error" : "warn",
			reason: outcome,
			status: null,
		});
		return Response.json(HUMAN_VERIFICATION_FAILURE_BODY, {headers: {"Cache-Control": "no-store"}, status: 403});
	};
}

enum PublicAuthenticationOperation {
	Register = "register",
	RequestMagicLink = "request_magic_link",
	RequestPasswordRecovery = "request_password_recovery",
	RequestVerification = "request_verification",
	SignIn = "sign_in",
}

const PUBLIC_AUTHENTICATION_ACCEPTED_BODY = {
	message: "If the request can be completed, check your inbox for next steps.",
	status: true,
} as const;
const PUBLIC_SIGN_IN_FAILURE_BODY = {
	code: "AUTHENTICATION_FAILED",
	message: "Sign-in failed. Check your email and password, or recover your account.",
} as const;

function authenticationLibraryReason(message: string): string {
	if (message.startsWith("Sign-up attempt for existing email:")) {
		return "existing_registration";
	}
	switch (message) {
		case "Invalid password":
			return "invalid_password";
		case "Password not found":
			return "password_not_found";
		case "Reset Password: User not found":
			return "password_recovery_user_not_found";
		case "User not found":
			return "user_not_found";
		default:
			return "library_event";
	}
}

async function publicAuthenticationOperation(request: Request): Promise<PublicAuthenticationOperation | null> {
	if (request.method !== "POST") {
		return null;
	}
	const body = await request
		.clone()
		.json()
		.catch(() => null);
	switch (new URL(request.url).pathname) {
		case EMAIL_REGISTRATION_PATH:
			return emailRegistrationSchema.safeParse(body).success ? PublicAuthenticationOperation.Register : null;
		case EMAIL_SIGN_IN_PATH:
			return emailSignInSchema.safeParse(body).success ? PublicAuthenticationOperation.SignIn : null;
		case MAGIC_LINK_SIGN_IN_PATH:
			return magicLinkSignInSchema.safeParse(body).success
				? PublicAuthenticationOperation.RequestMagicLink
				: null;
		case EMAIL_VERIFICATION_REQUEST_PATH:
			return emailVerificationRequestSchema.safeParse(body).success
				? PublicAuthenticationOperation.RequestVerification
				: null;
		case PASSWORD_RECOVERY_REQUEST_PATH:
			return passwordRecoveryRequestSchema.safeParse(body).success
				? PublicAuthenticationOperation.RequestPasswordRecovery
				: null;
		default:
			return null;
	}
}

async function waitForPublicAuthenticationResponseFloor(
	startedAt: number,
	timing: AuthenticationDependencies["publicAuthenticationTiming"],
): Promise<void> {
	const remainingMilliseconds =
		PUBLIC_AUTHENTICATION_RESPONSE_FLOOR_MILLISECONDS - (timing.currentMilliseconds() - startedAt);
	if (remainingMilliseconds > 0) {
		await timing.wait(remainingMilliseconds);
	}
}

function publicAuthenticationResponse(operation: PublicAuthenticationOperation): Response {
	const headers = {"Cache-Control": "no-store"};
	return operation === PublicAuthenticationOperation.SignIn
		? Response.json(PUBLIC_SIGN_IN_FAILURE_BODY, {headers, status: 401})
		: Response.json(PUBLIC_AUTHENTICATION_ACCEPTED_BODY, {headers});
}

function nonEnumeratingAuthenticationHandler(dependencies: AuthenticationDependencies): AuthenticationMiddleware {
	return (next) => async (request) => {
		const operation = await publicAuthenticationOperation(request);
		if (operation === null) {
			return next(request);
		}
		const startedAt = dependencies.publicAuthenticationTiming.currentMilliseconds();
		let response: Response;
		try {
			response = await next(request);
		} catch {
			dependencies.observe({
				event: "public_authentication_response_normalized",
				failure: null,
				level: "error",
				reason: operation,
				status: null,
			});
			await waitForPublicAuthenticationResponseFloor(startedAt, dependencies.publicAuthenticationTiming);
			return publicAuthenticationResponse(operation);
		}
		if (operation === PublicAuthenticationOperation.SignIn && response.ok) {
			await waitForPublicAuthenticationResponseFloor(startedAt, dependencies.publicAuthenticationTiming);
			return response;
		}
		dependencies.observe({
			event: "public_authentication_response_normalized",
			failure: null,
			level: response.ok ? "info" : "warn",
			reason: operation,
			status: response.status,
		});
		await waitForPublicAuthenticationResponseFloor(startedAt, dependencies.publicAuthenticationTiming);
		return publicAuthenticationResponse(operation);
	};
}

// 📊 Method-usage telemetry: which mechanism completed, never who used it. `reason` is drawn from a
// closed set of mechanism names so no email, token, or provider account id can reach a log sink.
const COMPLETED_AUTHENTICATION_METHODS: ReadonlyMap<string, string> = new Map([
	[`${AUTHENTICATION_PATH}/magic-link/verify`, "magic_link"],
	[`${AUTHENTICATION_PATH}/passkey/verify-authentication`, "passkey"],
	[`${AUTHENTICATION_PATH}/passkey/verify-registration`, "passkey_registered"],
	[EMAIL_VERIFICATION_PATH, "email_verification"],
	...SOCIAL_PROVIDERS.map(
		(provider) => [`${AUTHENTICATION_PATH}/callback/${provider}`, `social_${provider}`] as const,
	),
]);

function methodUsageAuthenticationHandler(observe: AuthenticationDependencies["observe"]): AuthenticationMiddleware {
	return (next) => async (request) => {
		const method = COMPLETED_AUTHENTICATION_METHODS.get(new URL(request.url).pathname);
		if (method === undefined) {
			return next(request);
		}
		const response = await next(request);
		observe({
			event: "authentication_method_completed",
			failure: null,
			level: response.status >= 400 ? "warn" : "info",
			reason: method,
			status: response.status,
		});
		return response;
	};
}

// 🔎 Silence has three causes and only one of them is a delivery fault: a genuinely unverified
// account gets a message, while an already-verified account and an unknown address deliberately get
// none. The public response cannot say which, so the classification lives here, in diagnostics that
// name the state without naming the address.
enum VerificationAccountState {
	AlreadyVerified = "already_verified",
	Unknown = "unknown_account",
	Unverified = "unverified_account",
}

async function verificationAccountState(database: D1Database, email: string): Promise<VerificationAccountState> {
	const account = await database
		.prepare("SELECT email_verified FROM user WHERE email = ?")
		.bind(email.toLowerCase())
		.first<{email_verified: number}>();
	if (account === null) {
		return VerificationAccountState.Unknown;
	}
	return account.email_verified === 1
		? VerificationAccountState.AlreadyVerified
		: VerificationAccountState.Unverified;
}

function verificationStateAuthenticationHandler(
	database: D1Database,
	observe: AuthenticationDependencies["observe"],
): AuthenticationMiddleware {
	return (next) => async (request) => {
		if (request.method !== "POST" || new URL(request.url).pathname !== EMAIL_VERIFICATION_REQUEST_PATH) {
			return next(request);
		}
		const parsed = emailVerificationRequestSchema.safeParse(
			await request
				.clone()
				.json()
				.catch(() => null),
		);
		if (!parsed.success) {
			return next(request);
		}
		observe({
			event: "authentication_verification_state_classified",
			failure: null,
			level: "info",
			reason: await verificationAccountState(database, parsed.data.email),
			status: null,
		});
		return next(request);
	};
}

function nameFreeAuthenticationHandler(): AuthenticationMiddleware {
	return (next) => async (request) => {
		const url = new URL(request.url);
		if (request.method !== "POST" || url.pathname !== EMAIL_REGISTRATION_PATH) {
			return next(request);
		}
		const registration = emailRegistrationSchema.safeParse(await request.json().catch(() => null));
		if (!registration.success) {
			return Response.json(
				{code: "INVALID_REGISTRATION_REQUEST", message: "Registration requires an email and password"},
				{status: 400},
			);
		}
		const headers = new Headers(request.headers);
		headers.delete("Content-Length");
		return next(
			new Request(request.url, {
				method: request.method,
				headers,
				body: JSON.stringify({...registration.data, name: ""}),
			}),
		);
	};
}

function isLoopbackRedirectUri(value: string): boolean {
	const url = new URL(value);
	const ipv4Octets = url.hostname.split(".");
	const isIpv4Loopback =
		ipv4Octets.length === 4 &&
		ipv4Octets[0] === "127" &&
		ipv4Octets.every((octet) => /^\d+$/.test(octet) && Number(octet) <= 255);
	return (
		url.protocol === "http:" &&
		(url.hostname === "localhost" || url.hostname === "[::1]" || isIpv4Loopback) &&
		url.username === "" &&
		url.password === "" &&
		url.hash === ""
	);
}

function hasExactOAuthScopes(scope: string | undefined): boolean {
	if (scope === undefined) {
		return true;
	}
	const requestedScopes = scope.split(" ");
	return (
		requestedScopes.length === new Set(requestedScopes).size &&
		requestedScopes.every((requestedScope) => OAUTH_SCOPE_SET.has(requestedScope))
	);
}

function refusedClientRegistration(reason: string): Response {
	return Response.json(
		{
			error: "invalid_client_metadata",
			error_description: `Client registration metadata is not permitted: ${reason}`,
		},
		{status: 400},
	);
}

function restrictedDynamicClientRegistrationHandler(): AuthenticationMiddleware {
	return (next) => async (request) => {
		const url = new URL(request.url);
		if (request.method !== "POST" || url.pathname !== `${AUTHENTICATION_PATH}/oauth2/register`) {
			return next(request);
		}
		const parsed = dynamicClientRegistrationSchema.safeParse(
			await request
				.clone()
				.json()
				.catch(() => null),
		);
		if (!parsed.success) {
			return refusedClientRegistration(invalidRegistrationMembers(parsed.error));
		}
		const refusal = impermissibleRegistrationMember(parsed.data, `${url.origin}${MCP_RESOURCE_PATH}`);
		if (refusal !== null) {
			return refusedClientRegistration(refusal);
		}
		// Better Auth defaults an absent application_type to "web" and then rejects the loopback
		// redirect URIs these clients must use, so name the native client type the request implies.
		// Forwarding the parsed metadata is also what ignoring unmodelled members means in practice:
		// they are dropped here instead of being stored by the provider or echoed back.
		const headers = new Headers(request.headers);
		headers.delete("Content-Length");
		return next(
			new Request(request.url, {
				method: "POST",
				headers,
				body: JSON.stringify({...parsed.data, application_type: "native"}),
			}),
		);
	};
}

function singleUseEmailVerificationHandler(database: D1Database): AuthenticationMiddleware {
	return (next) => async (request) => {
		const url = new URL(request.url);
		if (request.method !== "GET" || url.pathname !== EMAIL_VERIFICATION_PATH) {
			return next(request);
		}
		const token = url.searchParams.get("token");
		if (token === null) {
			return next(request);
		}
		const consumed = await database
			.prepare("DELETE FROM verification WHERE identifier = ? RETURNING id")
			.bind(`${EMAIL_VERIFICATION_IDENTIFIER_PREFIX}${await hashToken(token)}`)
			.first();
		if (consumed !== null) {
			return next(request);
		}
		url.searchParams.set("token", "consumed");
		return next(new Request(url, request));
	};
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function authenticationEmail(
	environment: AuthenticationEnvironment,
	to: string,
	url: string,
	copy: AuthenticationEmailCopy,
): AuthenticationEmail {
	const safeActionLabel = escapeHtml(copy.actionLabel);
	const safeExpiry = escapeHtml(`This link expires in ${copy.expiry}.`);
	const safeIntroduction = escapeHtml(copy.introduction);
	const safePreheader = escapeHtml(copy.preheader);
	const safeSubject = escapeHtml(copy.subject);
	const safeUrl = escapeHtml(url);
	return {
		to,
		from: {email: environment.AUTH_EMAIL_FROM, name: "YepNope"},
		subject: copy.subject,
		text: `${copy.introduction}\n\n${copy.actionLabel}: ${url}\n\nThis link expires in ${copy.expiry}. If you did not request this, you can ignore this email.`,
		html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${safeSubject}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;color:#18181b;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${safePreheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;background-color:#f4f4f5;">
<tr>
<td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;border-collapse:separate;background-color:#ffffff;border:1px solid #e4e4e7;border-radius:12px;">
<tr>
<td style="padding:28px;font-family:Arial,Helvetica,sans-serif;">
<p style="margin:0 0 20px;color:#52525b;font-size:14px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">YepNope</p>
<h1 style="margin:0 0 12px;color:#18181b;font-size:24px;line-height:1.25;font-weight:700;">${safeSubject}</h1>
<p style="margin:0 0 24px;color:#3f3f46;font-size:16px;line-height:1.5;">${safeIntroduction}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
<tr>
<td style="border-radius:8px;background-color:#18181b;">
<a href="${safeUrl}" style="display:inline-block;padding:12px 20px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;line-height:1.25;text-decoration:none;border-radius:8px;">${safeActionLabel}</a>
</td>
</tr>
</table>
<p style="margin:24px 0 0;color:#52525b;font-size:14px;line-height:1.5;">${safeExpiry}</p>
<p style="margin:12px 0 0;color:#71717a;font-size:12px;line-height:1.5;">Button not working? <a href="${safeUrl}" style="color:#52525b;text-decoration:underline;">Open this secure link</a>.</p>
<p style="margin:20px 0 0;padding-top:20px;border-top:1px solid #e4e4e7;color:#71717a;font-size:12px;line-height:1.5;">If you did not request this, you can ignore this email.</p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`,
	};
}

/**
 * The WebAuthn half of Better Auth, handed in rather than imported. See
 * `createPasskeyAuthentication` for why it arrives this way.
 */
type PasskeyPlugin = ReturnType<typeof import("@better-auth/passkey").passkey>;

export function createAuthentication(
	environment: AuthenticationEnvironment,
	dependencies: AuthenticationDependencies,
	passkeyPlugin: PasskeyPlugin | null = null,
) {
	const database = drizzle(environment.DB, {
		schema: authenticationSchema,
	});
	const resource = `${environment.BETTER_AUTH_URL}${MCP_RESOURCE_PATH}`;
	const authentication = betterAuth({
		appName: "YepNope",
		baseURL: environment.BETTER_AUTH_URL,
		basePath: AUTHENTICATION_PATH,
		secret: environment.BETTER_AUTH_SECRET,
		trustedOrigins: [environment.BETTER_AUTH_URL],
		logger: {
			level: "debug",
			log: (level, message) => {
				dependencies.observe({
					event: "authentication_library_log",
					failure: null,
					level,
					reason: authenticationLibraryReason(message),
					status: null,
				});
			},
		},
		database: drizzleAdapter(database, {
			provider: "sqlite",
			schema: authenticationSchema,
		}),
		plugins: [
			jwt(),
			magicLink({
				expiresIn: MAGIC_LINK_EXPIRY_SECONDS,
				rateLimit: MAGIC_LINK_RATE_LIMIT,
				// 🔐 A leaked database row must not be a usable sign-in link.
				storeToken: {type: "custom-hasher", hash: hashToken},
				sendMagicLink: async ({email, url}) =>
					sendAuthenticationEmail(
						dependencies,
						authenticationEmail(environment, email, url, {
							actionLabel: "Sign in",
							expiry: "15 minutes",
							introduction: "Use this link to sign in to YepNope. No password needed.",
							preheader: "Your YepNope sign-in link.",
							subject: "Sign in to YepNope",
						}),
						PublicAuthenticationOperation.RequestMagicLink,
					),
			}),
			// @ts-expect-error Better Auth 1.7 plugin metadata conflicts with exactOptionalPropertyTypes.
			mcp({
				accessTokenExpiresIn: OAUTH_ACCESS_TOKEN_EXPIRY_SECONDS,
				allowDynamicClientRegistration: true,
				allowUnauthenticatedClientRegistration: true,
				clientRegistrationDefaultScopes: [...OAUTH_SCOPES],
				clientRegistrationRequirePKCE: true,
				codeExpiresIn: OAUTH_AUTHORIZATION_CODE_EXPIRY_SECONDS,
				consentPage: OAUTH_CONSENT_PATH,
				grantTypes: ["authorization_code", "refresh_token"],
				loginPage: "/sign-in",
				rateLimit: {
					authorize: {window: 60, max: 20},
					introspect: {window: 60, max: 60},
					register: {window: 60, max: 5},
					revoke: {window: 60, max: 20},
					token: {window: 60, max: 20},
					userinfo: {window: 60, max: 30},
				},
				refreshTokenExpiresIn: OAUTH_REFRESH_TOKEN_EXPIRY_SECONDS,
				refreshTokenReuseInterval: 0,
				resource,
				scopes: [...OAUTH_SCOPES],
			}),
			// 📟 The device grant issues the same scoped, audience-bound, refreshable token set the
			// browser flow does. It exists so the Claude Code hook — a local command with no browser
			// and no callback port — stops needing a second authentication system of its own.
			oauthDeviceAuthorization({
				expiresIn: DEVICE_CODE_EXPIRY,
				interval: DEVICE_CODE_POLLING_INTERVAL,
				verificationUri: `${environment.BETTER_AUTH_URL}${DEVICE_AUTHORIZATION_PATH}`,
			}),
			...(passkeyPlugin === null ? [] : [passkeyPlugin]),
		],
		socialProviders: socialProviderCredentials(environment),
		account: {
			accountLinking: {
				enabled: true,
				// 🛡️ Duplicate-email protection. Linking needs the provider's own verified-email claim
				// (no provider is blanket-trusted), the addresses must match exactly, and Better Auth's
				// default requireLocalEmailVerified gate keeps a pre-registered unverified local row
				// from absorbing a victim's social identity.
				allowDifferentEmails: false,
				disableImplicitLinking: false,
				trustedProviders: [],
			},
		},
		emailVerification: {
			sendOnSignUp: false,
			sendOnSignIn: true,
			autoSignInAfterVerification: true,
			expiresIn: AUTHENTICATION_TOKEN_EXPIRY_SECONDS,
			sendVerificationEmail: async ({user, url, token}) => {
				await database.insert(verifications).values({
					id: crypto.randomUUID(),
					identifier: `${EMAIL_VERIFICATION_IDENTIFIER_PREFIX}${await hashToken(token)}`,
					value: user.id,
					expiresAt: new Date(Date.now() + AUTHENTICATION_TOKEN_EXPIRY_SECONDS * 1_000),
				});
				await sendAuthenticationEmail(
					dependencies,
					authenticationEmail(environment, user.email, url, {
						actionLabel: "Verify email",
						expiry: "one hour",
						introduction: "Verify your email address to finish creating your YepNope account.",
						preheader: "Verify your email to finish setting up YepNope.",
						subject: "Verify your YepNope email",
					}),
					PublicAuthenticationOperation.RequestVerification,
				);
			},
		},
		emailAndPassword: {
			enabled: true,
			autoSignIn: false,
			requireEmailVerification: true,
			revokeSessionsOnPasswordReset: true,
			resetPasswordTokenExpiresIn: AUTHENTICATION_TOKEN_EXPIRY_SECONDS,
			sendResetPassword: async ({user, url}) =>
				sendAuthenticationEmail(
					dependencies,
					authenticationEmail(environment, user.email, url, {
						actionLabel: "Reset password",
						expiry: "one hour",
						introduction: "Choose a new password for your YepNope account.",
						preheader: "Reset your YepNope password securely.",
						subject: "Reset your YepNope password",
					}),
					PublicAuthenticationOperation.RequestPasswordRecovery,
				),
		},
		user: {
			additionalFields: {
				name: {type: "string", required: false, input: false, returned: false},
			},
			deleteUser: {
				enabled: true,
				beforeDelete: async (user) => {
					await deleteOAuthAuthorizationData(environment.DB, user.id);
					await markAccountDeletionRequested(environment.DB, user.id, Date.now());
				},
				afterDelete: async (user) => {
					await deleteAccountDurableObject(environment.DB, environment.USER_DO, user.id, Date.now());
				},
			},
		},
		databaseHooks: {
			user: {
				create: {
					before: async () => Promise.resolve({data: {name: undefined}}),
					after: async (user) => {
						await recordAccountIdentity(environment.DB, user.id, user.createdAt.getTime());
					},
				},
				update: {
					before: async () => Promise.resolve({data: {name: undefined}}),
				},
			},
		},
		advanced: {
			useSecureCookies: true,
			...(dependencies.runInBackground === undefined
				? {}
				: {backgroundTasks: {handler: dependencies.runInBackground}}),
		},
	});
	return {
		...authentication,
		// Outermost first. Human verification comes before everything so a refused request costs the
		// account store nothing, and it sits outside the non-enumerating normalizer so its refusal
		// reaches the page as a refusal instead of being rewritten into the accepted reply.
		// Telemetry sits inside that normalizer so it records the real status rather than the
		// generic one that reaches the caller.
		handler: composeAuthenticationMiddleware(
			[
				humanVerificationAuthenticationHandler(dependencies.verifyHuman, dependencies.observe),
				restrictedDynamicClientRegistrationHandler(),
				singleUseEmailVerificationHandler(environment.DB),
				nonEnumeratingAuthenticationHandler(dependencies),
				verificationStateAuthenticationHandler(environment.DB, dependencies.observe),
				methodUsageAuthenticationHandler(dependencies.observe),
				nameFreeAuthenticationHandler(),
			],
			authentication.handler,
		),
	};
}

async function deleteOAuthAuthorizationData(database: D1Database, userId: string): Promise<void> {
	await database.batch([
		database.prepare("DELETE FROM mcp_client_use WHERE user_id = ?").bind(userId),
		database.prepare("DELETE FROM oauth_access_token WHERE user_id = ?").bind(userId),
		database.prepare("DELETE FROM oauth_refresh_token WHERE user_id = ?").bind(userId),
		database.prepare("DELETE FROM oauth_consent WHERE user_id = ?").bind(userId),
		database
			.prepare(
				"DELETE FROM verification WHERE json_valid(value) " +
					"AND json_extract(value, '$.type') = 'authorization_code' " +
					"AND json_extract(value, '$.userId') = ?",
			)
			.bind(userId),
		database.prepare("DELETE FROM oauth_client WHERE user_id = ?").bind(userId),
	]);
}

let passkeyStackLoadedInThisIsolate = false;

/**
 * The same authentication, plus the seven `/api/auth/passkey/*` endpoints.
 *
 * 🧊 The import is deferred because of what it drags in. `@better-auth/passkey` statically pulls
 * `@simplewebauthn/server` and the `@peculiar` ASN.1/X.509 stack, which together cost about 24 ms
 * of V8 compile-and-evaluate on a cold isolate and register their ASN.1 converters at module-eval
 * time. Nothing outside a passkey ceremony can reach any of it, so an isolate that only ever serves
 * sessions, magic links, or OAuth never pays. The plugin contributes endpoints and a table and no
 * hooks or middleware, so the instances differ in exactly those seven routes — deleting an account
 * still erases its passkeys, because that cascade lives in the `passkey` table's foreign key.
 */
export async function createPasskeyAuthentication(
	environment: AuthenticationEnvironment,
	dependencies: AuthenticationDependencies,
): Promise<ReturnType<typeof createAuthentication>> {
	const {passkey} = await import("@better-auth/passkey");
	passkeyStackLoadedInThisIsolate = true;
	return createAuthentication(
		environment,
		dependencies,
		passkey({
			rpID: new URL(environment.BETTER_AUTH_URL).hostname,
			rpName: "YepNope",
			origin: environment.BETTER_AUTH_URL,
			authenticatorSelection: {residentKey: "preferred", userVerification: "preferred"},
		}),
	);
}

/** Whether this isolate has paid for the WebAuthn stack yet. The cold-start budget is a claim worth testing. */
export function passkeyStackLoaded(): boolean {
	return passkeyStackLoadedInThisIsolate;
}

// ⏳ One authentication instance now serves every concurrent request in the isolate, so the
// ExecutionContext that pays for deferred work cannot be captured when it is built. It rides
// alongside the request's async flow instead, which keeps a background email charged to the
// request that asked for it rather than to whichever request happened to arrive last.
const requestExecutionContexts = new AsyncLocalStorage<ExecutionContext>();

export function withRequestBackgroundTasks<T>(executionContext: ExecutionContext, work: () => T): T {
	return requestExecutionContexts.run(executionContext, work);
}

/**
 * 📝 The Worker's one observation sink. Bearer verification lives outside Better Auth but refuses
 * callers for the same reasons, so it records through here rather than inventing a second log shape.
 */
export function observeWorkerAuthentication(observation: AuthenticationObservation): void {
	console.warn(JSON.stringify(observation));
}

function workerDependencies(environment: Env): AuthenticationDependencies {
	return {
		observe: observeWorkerAuthentication,
		publicAuthenticationTiming: {
			currentMilliseconds: () => performance.now(),
			wait: async (milliseconds) =>
				new Promise<void>((resolve) => {
					setTimeout(resolve, milliseconds);
				}),
		},
		runInBackground: (promise) => {
			const executionContext = requestExecutionContexts.getStore();
			if (executionContext === undefined) {
				// No request lifetime to extend. Letting the work run unsupervised still beats
				// dropping it, and it keeps delivery off the response path either way.
				void promise.catch(() => undefined);
				return;
			}
			executionContext.waitUntil(promise);
		},
		sendEmail: async (message) => {
			await environment.EMAIL.send(message);
		},
		verifyHuman: createTurnstileVerifier(environment),
	};
}

// 🧊 Better Auth rebuilds its entire endpoint map on every construction, and the OAuth provider
// re-seeds its resource row into D1 from `init`, so building one per request charged every
// authenticated call for both. An isolate builds each instance once and hands out the same one
// afterwards.
interface IsolateAuthentication {
	environment: Env;
	shared: ReturnType<typeof createAuthentication>;
	withPasskeys: Promise<ReturnType<typeof createAuthentication>> | null;
}

let isolateAuthentication: IsolateAuthentication | null = null;

function isolateAuthenticationFor(environment: Env): IsolateAuthentication {
	if (isolateAuthentication === null || isolateAuthentication.environment !== environment) {
		isolateAuthentication = {
			environment,
			shared: createAuthentication(environment, workerDependencies(environment)),
			withPasskeys: null,
		};
	}
	return isolateAuthentication;
}

/** The instance every route but a passkey ceremony shares. */
export function workerAuthentication(environment: Env): ReturnType<typeof createAuthentication> {
	return isolateAuthenticationFor(environment).shared;
}

/** The instance that can answer `pathname`, which for `/api/auth/passkey/*` is the heavier one. */
export async function workerAuthenticationFor(
	environment: Env,
	pathname: string,
): Promise<ReturnType<typeof createAuthentication>> {
	const cached = isolateAuthenticationFor(environment);
	if (!pathname.startsWith(PASSKEY_PATH_PREFIX)) {
		return cached.shared;
	}
	// Caching the promise rather than its result means two simultaneous ceremonies on a cold
	// isolate load the WebAuthn stack once between them.
	cached.withPasskeys ??= createPasskeyAuthentication(environment, workerDependencies(environment));
	return cached.withPasskeys;
}

export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export async function authenticateBrowserSession(
	request: Request,
	environment: Env,
	executionContext: ExecutionContext,
): Promise<string | null> {
	return (await authenticateBrowserAccount(request, environment, executionContext))?.userId ?? null;
}

export interface AuthenticatedBrowserAccount {
	sessionId: string;
	userId: string;
}

export async function authenticateBrowserAccount(
	request: Request,
	environment: Env,
	executionContext: ExecutionContext,
): Promise<AuthenticatedBrowserAccount | null> {
	const session = await withRequestBackgroundTasks(executionContext, async () =>
		workerAuthentication(environment).api.getSession({headers: request.headers}),
	);
	return session?.user.emailVerified === true ? {sessionId: session.session.id, userId: session.user.id} : null;
}
