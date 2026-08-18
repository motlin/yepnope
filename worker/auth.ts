import {drizzleAdapter} from "@better-auth/drizzle-adapter";
import {betterAuth} from "better-auth";
import {and, eq, isNull} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {accounts, machineTokens, sessions, users, verifications} from "./db/d1-schema";

const AUTHENTICATION_PATH = "/api/auth";

type AuthenticationEnvironment = Pick<Env, "AUTH_EMAIL_FROM" | "BETTER_AUTH_SECRET" | "BETTER_AUTH_URL" | "DB">;
type AuthenticationEmail = Parameters<SendEmail["send"]>[0];

export interface AuthenticationDependencies {
	runInBackground: ((promise: Promise<unknown>) => void) | undefined;
	sendEmail: (message: AuthenticationEmail) => Promise<void>;
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
	subject: string,
	introduction: string,
	url: string,
): AuthenticationEmail {
	const safeUrl = escapeHtml(url);
	return {
		to,
		from: {email: environment.AUTH_EMAIL_FROM, name: "YepNope"},
		subject,
		text: `${introduction}\n\n${url}\n\nIf you did not request this, you can ignore this email.`,
		html: `<p>${introduction}</p><p><a href="${safeUrl}">${safeUrl}</a></p><p>If you did not request this, you can ignore this email.</p>`,
	};
}

export function createAuthentication(environment: AuthenticationEnvironment, dependencies: AuthenticationDependencies) {
	const database = drizzle(environment.DB, {
		schema: {account: accounts, session: sessions, user: users, verification: verifications},
	});
	return betterAuth({
		appName: "YepNope",
		baseURL: environment.BETTER_AUTH_URL,
		basePath: AUTHENTICATION_PATH,
		secret: environment.BETTER_AUTH_SECRET,
		trustedOrigins: [environment.BETTER_AUTH_URL],
		database: drizzleAdapter(database, {
			provider: "sqlite",
			schema: {account: accounts, session: sessions, user: users, verification: verifications},
		}),
		account: {
			accountLinking: {
				enabled: true,
				allowDifferentEmails: false,
				disableImplicitLinking: false,
			},
		},
		emailVerification: {
			sendOnSignUp: true,
			sendOnSignIn: true,
			autoSignInAfterVerification: false,
			sendVerificationEmail: async ({user, url}) =>
				dependencies.sendEmail(
					authenticationEmail(
						environment,
						user.email,
						"Verify your YepNope email",
						"Verify your email address to finish creating your YepNope account:",
						url,
					),
				),
		},
		emailAndPassword: {
			enabled: true,
			autoSignIn: false,
			requireEmailVerification: true,
			sendResetPassword: async ({user, url}) =>
				dependencies.sendEmail(
					authenticationEmail(
						environment,
						user.email,
						"Reset your YepNope password",
						"Use this link to choose a new YepNope password:",
						url,
					),
				),
		},
		advanced: {
			useSecureCookies: true,
			...(dependencies.runInBackground === undefined
				? {}
				: {backgroundTasks: {handler: dependencies.runInBackground}}),
		},
	});
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
