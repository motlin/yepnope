import {mcp} from "@better-auth/mcp";
import {drizzleAdapter} from "@better-auth/drizzle-adapter";
import {betterAuth} from "better-auth";
import {jwt} from "better-auth/plugins";
import {and, eq, isNull} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {z} from "zod";
import {
	accounts,
	jsonWebKeys,
	machineTokens,
	oauthAccessTokens,
	oauthClientAssertions,
	oauthClientResources,
	oauthClients,
	oauthConsents,
	oauthRefreshTokens,
	oauthResources,
	sessions,
	users,
	verifications,
} from "./db/d1-schema";
import {deleteAccountDurableObject, markAccountDeletionRequested, recordAccountIdentity} from "./identity-lifecycle";

const AUTHENTICATION_PATH = "/api/auth";
const EMAIL_REGISTRATION_PATH = `${AUTHENTICATION_PATH}/sign-up/email`;
const EMAIL_VERIFICATION_PATH = `${AUTHENTICATION_PATH}/verify-email`;
const EMAIL_VERIFICATION_IDENTIFIER_PREFIX = "yepnope-email-verification:";
const AUTHENTICATION_TOKEN_EXPIRY_SECONDS = 60 * 60;
const OAUTH_ACCESS_TOKEN_EXPIRY_SECONDS = 10 * 60;
const OAUTH_AUTHORIZATION_CODE_EXPIRY_SECONDS = 5 * 60;
const OAUTH_REFRESH_TOKEN_EXPIRY_SECONDS = 30 * 24 * 60 * 60;
export const MCP_RESOURCE_PATH = "/mcp";
const OAUTH_CONSENT_PATH = "/oauth/consent";
export const OAUTH_SCOPES = ["openid", "offline_access", "yepnope:questions", "yepnope:afk"] as const;
const OAUTH_SCOPE_SET: ReadonlySet<string> = new Set(OAUTH_SCOPES);
const emailRegistrationSchema = z
	.object({
		callbackURL: z.string().optional(),
		email: z.email(),
		password: z.string(),
		rememberMe: z.boolean().optional(),
	})
	.strict();
const dynamicClientRegistrationSchema = z
	.object({
		application_type: z.literal("native"),
		client_name: z.string().trim().min(1).max(120).optional(),
		client_uri: z.url().optional(),
		contacts: z.array(z.email()).max(5).optional(),
		grant_types: z
			.array(z.enum(["authorization_code", "refresh_token"]))
			.min(1)
			.max(2),
		logo_uri: z.url().optional(),
		policy_uri: z.url().optional(),
		redirect_uris: z.array(z.url()).min(1).max(8),
		resources: z.array(z.string()).max(1).optional(),
		response_types: z.tuple([z.literal("code")]),
		scope: z.string().optional(),
		software_id: z.string().trim().min(1).max(120).optional(),
		software_version: z.string().trim().min(1).max(60).optional(),
		token_endpoint_auth_method: z.literal("none"),
		tos_uri: z.url().optional(),
	})
	.strict();

const authenticationSchema = {
	account: accounts,
	jwks: jsonWebKeys,
	oauthAccessToken: oauthAccessTokens,
	oauthClient: oauthClients,
	oauthClientAssertion: oauthClientAssertions,
	oauthClientResource: oauthClientResources,
	oauthConsent: oauthConsents,
	oauthRefreshToken: oauthRefreshTokens,
	oauthResource: oauthResources,
	session: sessions,
	user: users,
	verification: verifications,
};

type AuthenticationEnvironment = Pick<
	Env,
	"AUTH_EMAIL_FROM" | "BETTER_AUTH_SECRET" | "BETTER_AUTH_URL" | "DB" | "USER_DO"
>;
type AuthenticationEmail = Parameters<SendEmail["send"]>[0];

interface AuthenticationEmailCopy {
	actionLabel: string;
	introduction: string;
	preheader: string;
	subject: string;
}

export interface AuthenticationDependencies {
	runInBackground: ((promise: Promise<unknown>) => void) | undefined;
	sendEmail: (message: AuthenticationEmail) => Promise<void>;
}

async function nameFreeAuthenticationHandler(
	handler: (request: Request) => Promise<Response>,
	request: Request,
): Promise<Response> {
	const url = new URL(request.url);
	if (request.method !== "POST" || url.pathname !== EMAIL_REGISTRATION_PATH) {
		return handler(request);
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
	return handler(
		new Request(request.url, {
			method: request.method,
			headers,
			body: JSON.stringify({...registration.data, name: ""}),
		}),
	);
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

async function restrictedDynamicClientRegistrationHandler(
	handler: (request: Request) => Promise<Response>,
	request: Request,
): Promise<Response> {
	const url = new URL(request.url);
	if (request.method !== "POST" || url.pathname !== `${AUTHENTICATION_PATH}/oauth2/register`) {
		return handler(request);
	}
	const parsed = dynamicClientRegistrationSchema.safeParse(
		await request
			.clone()
			.json()
			.catch(() => null),
	);
	if (
		!parsed.success ||
		!parsed.data.grant_types.includes("authorization_code") ||
		!parsed.data.redirect_uris.every(isLoopbackRedirectUri) ||
		!hasExactOAuthScopes(parsed.data.scope) ||
		(parsed.data.resources !== undefined &&
			(parsed.data.resources.length !== 1 || parsed.data.resources[0] !== `${url.origin}${MCP_RESOURCE_PATH}`))
	) {
		return Response.json(
			{error: "invalid_client_metadata", error_description: "Client registration metadata is not permitted"},
			{status: 400},
		);
	}
	return handler(request);
}

async function singleUseEmailVerificationHandler(
	handler: (request: Request) => Promise<Response>,
	request: Request,
	database: D1Database,
): Promise<Response> {
	const url = new URL(request.url);
	if (request.method !== "GET" || url.pathname !== EMAIL_VERIFICATION_PATH) {
		return handler(request);
	}
	const token = url.searchParams.get("token");
	if (token === null) {
		return handler(request);
	}
	const consumed = await database
		.prepare("DELETE FROM verification WHERE identifier = ? RETURNING id")
		.bind(`${EMAIL_VERIFICATION_IDENTIFIER_PREFIX}${await hashToken(token)}`)
		.first();
	if (consumed !== null) {
		return handler(request);
	}
	url.searchParams.set("token", "consumed");
	return handler(new Request(url, request));
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
	const safeIntroduction = escapeHtml(copy.introduction);
	const safePreheader = escapeHtml(copy.preheader);
	const safeSubject = escapeHtml(copy.subject);
	const safeUrl = escapeHtml(url);
	return {
		to,
		from: {email: environment.AUTH_EMAIL_FROM, name: "YepNope"},
		subject: copy.subject,
		text: `${copy.introduction}\n\n${copy.actionLabel}: ${url}\n\nThis link expires in one hour. If you did not request this, you can ignore this email.`,
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
<p style="margin:24px 0 0;color:#52525b;font-size:14px;line-height:1.5;">This link expires in one hour.</p>
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

export function createAuthentication(environment: AuthenticationEnvironment, dependencies: AuthenticationDependencies) {
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
		database: drizzleAdapter(database, {
			provider: "sqlite",
			schema: authenticationSchema,
		}),
		plugins: [
			jwt(),
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
		],
		account: {
			accountLinking: {
				enabled: true,
				allowDifferentEmails: false,
				disableImplicitLinking: false,
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
				await dependencies.sendEmail(
					authenticationEmail(environment, user.email, url, {
						actionLabel: "Verify email",
						introduction: "Verify your email address to finish creating your YepNope account.",
						preheader: "Verify your email to finish setting up YepNope.",
						subject: "Verify your YepNope email",
					}),
				);
			},
		},
		emailAndPassword: {
			enabled: true,
			autoSignIn: false,
			requireEmailVerification: true,
			resetPasswordTokenExpiresIn: AUTHENTICATION_TOKEN_EXPIRY_SECONDS,
			sendResetPassword: async ({user, url}) =>
				dependencies.sendEmail(
					authenticationEmail(environment, user.email, url, {
						actionLabel: "Reset password",
						introduction: "Choose a new password for your YepNope account.",
						preheader: "Reset your YepNope password securely.",
						subject: "Reset your YepNope password",
					}),
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
		handler: async (request: Request) =>
			restrictedDynamicClientRegistrationHandler(
				async (registrationRequest) =>
					singleUseEmailVerificationHandler(
						async (authenticationRequest) =>
							nameFreeAuthenticationHandler(authentication.handler, authenticationRequest),
						registrationRequest,
						environment.DB,
					),
				request,
			),
	};
}

async function deleteOAuthAuthorizationData(database: D1Database, userId: string): Promise<void> {
	await database.batch([
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

export function createWorkerAuthentication(
	environment: Env,
	executionContext: ExecutionContext,
): ReturnType<typeof createAuthentication> {
	return createAuthentication(environment, {
		runInBackground: (promise) => {
			executionContext.waitUntil(promise);
		},
		sendEmail: async (message) => {
			await environment.EMAIL.send(message);
		},
	});
}

export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

// 🔑 Resolves the machine token to a user id, which names the per-user Durable Object.
async function authenticateMachineToken(request: Request, database: D1Database): Promise<string | null> {
	const header = request.headers.get("Authorization");
	if (header === null || !header.startsWith("Bearer ")) {
		return null;
	}
	const tokenHash = await hashToken(header.slice("Bearer ".length));
	const connection = drizzle(database);
	const rows = await connection
		.select({userId: machineTokens.userId})
		.from(machineTokens)
		.where(
			and(
				eq(machineTokens.tokenHash, tokenHash),
				eq(machineTokens.credentialType, "machine"),
				isNull(machineTokens.revokedAt),
			),
		);
	const authenticated = rows[0];
	if (authenticated === undefined) {
		return null;
	}
	await connection.update(machineTokens).set({lastUsedAt: Date.now()}).where(eq(machineTokens.tokenHash, tokenHash));
	return authenticated.userId;
}

export async function authenticateRequest(
	request: Request,
	environment: Env,
	executionContext: ExecutionContext,
): Promise<string | null> {
	const machineUserId = await authenticateMachineToken(request, environment.DB);
	if (machineUserId !== null) {
		return machineUserId;
	}
	const session = await createWorkerAuthentication(environment, executionContext).api.getSession({
		headers: request.headers,
	});
	return session?.user.emailVerified === true ? session.user.id : null;
}

export async function authenticateBrowserSession(
	request: Request,
	environment: Env,
	executionContext: ExecutionContext,
): Promise<string | null> {
	const session = await createWorkerAuthentication(environment, executionContext).api.getSession({
		headers: request.headers,
	});
	return session?.user.emailVerified === true ? session.user.id : null;
}
