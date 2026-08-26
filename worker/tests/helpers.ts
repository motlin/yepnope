import {runInDurableObject} from "cloudflare:test";
import {env, exports} from "cloudflare:workers";
import {
	createAuthentication,
	createPasskeyAuthentication,
	type AuthenticationDependencies,
	type AuthenticationObservation,
} from "../auth";
import {HUMAN_VERIFICATION_HEADER, HumanVerificationOutcome, type HumanVerificationVerifier} from "../turnstile";
import {testTurnstileToken} from "../turnstile-test-siteverify";
import type {UserDurableObject} from "../user-do";
import type {CreateBatchRequest} from "../validation";
import {authorizeDeviceClient} from "./oauth-client-helpers";

export const API_ORIGIN = "https://yepnope.app";

/**
 * A visitor who has already cleared the human-verification check. The gate itself is exercised in
 * worker/tests/turnstile.test.ts; every other suite states plainly that it was passed, so the
 * behavior actually under test stays the only variable.
 */
export const humanVerified: HumanVerificationVerifier = async () => Promise.resolve(HumanVerificationOutcome.Accepted);

/**
 * A token the Worker's own test Siteverify will redeem, for the suites that drive `worker.fetch`
 * rather than injecting a verifier.
 */
export function humanVerificationHeader(action: string): Record<string, string> {
	return {
		[HUMAN_VERIFICATION_HEADER]: testTurnstileToken({action, hostname: new URL(API_ORIGIN).hostname}),
	};
}

export const worker = exports.default;

export const AUTHENTICATION_PASSWORD = "correct-horse-battery-staple";

export interface DeliveredAuthenticationEmail {
	from: string | EmailAddress;
	html: string;
	subject: string;
	text: string;
	to: string | EmailAddress | (string | EmailAddress)[];
}

/**
 * An authentication instance whose emails land in an array and whose observations land in another,
 * so a test can read both without a live email service or log sink.
 */
export interface AuthenticationHarness {
	authentication: ReturnType<typeof createAuthentication>;
	mailbox: DeliveredAuthenticationEmail[];
	observations: AuthenticationObservation[];
	publicAuthenticationWaits: number[];
}

export const immediatePublicAuthenticationTiming: AuthenticationDependencies["publicAuthenticationTiming"] = {
	currentMilliseconds: () => 0,
	wait: async () => Promise.resolve(),
};

function mailboxHarnessParts(overrides: Partial<Env>) {
	const mailbox: DeliveredAuthenticationEmail[] = [];
	const observations: AuthenticationObservation[] = [];
	const publicAuthenticationWaits: number[] = [];
	return {
		environment: {...env, ...overrides},
		mailbox,
		observations,
		publicAuthenticationWaits,
		dependencies: {
			observe: (observation: AuthenticationObservation) => observations.push(observation),
			publicAuthenticationTiming: {
				currentMilliseconds: () => 0,
				wait: async (milliseconds: number) => {
					await Promise.resolve(publicAuthenticationWaits.push(milliseconds));
				},
			},
			runInBackground: undefined,
			sendEmail: async (message: Parameters<SendEmail["send"]>[0]) => {
				await Promise.resolve(
					mailbox.push({
						from: message.from,
						html: required(message.html, "email HTML"),
						subject: message.subject,
						text: required(message.text, "email text"),
						to: required(message.to, "email recipient"),
					}),
				);
			},
			verifyHuman: humanVerified,
		},
	};
}

export function authenticationWithMailbox(overrides: Partial<Env> = {}): AuthenticationHarness {
	const {environment, dependencies, mailbox, observations, publicAuthenticationWaits} =
		mailboxHarnessParts(overrides);
	return {
		authentication: createAuthentication(environment, dependencies),
		mailbox,
		observations,
		publicAuthenticationWaits,
	};
}

/** Passkey ceremonies are served by the lazily loaded instance, so this harness awaits that import. */
export async function passkeyAuthenticationWithMailbox(overrides: Partial<Env> = {}): Promise<AuthenticationHarness> {
	const {environment, dependencies, mailbox, observations, publicAuthenticationWaits} =
		mailboxHarnessParts(overrides);
	return {
		authentication: await createPasskeyAuthentication(environment, dependencies),
		mailbox,
		observations,
		publicAuthenticationWaits,
	};
}

export function postAuthentication(path: string, body: Record<string, unknown>, cookie?: string): Request {
	const headers = new Headers({"Content-Type": "application/json", Origin: API_ORIGIN});
	if (cookie !== undefined) {
		headers.set("Cookie", cookie);
	}
	return new Request(`${API_ORIGIN}/api/auth/${path}`, {method: "POST", headers, body: JSON.stringify(body)});
}

export function getAuthentication(path: string, cookie?: string): Request {
	const headers = new Headers({Origin: API_ORIGIN});
	if (cookie !== undefined) {
		headers.set("Cookie", cookie);
	}
	return new Request(`${API_ORIGIN}/api/auth/${path}`, {headers});
}

export function cookieFrom(response: Response): string {
	const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
	return required(cookie, "session cookie");
}

export function emailLink(email: {text: string}): string {
	const url = /https:\/\/\S+/.exec(email.text)?.[0];
	return required(url, "authentication email link");
}

export async function createVerifiedBrowserSession(
	email = `alice-${crypto.randomUUID()}@example.com`,
): Promise<{cookie: string; userId: string}> {
	const {authentication, mailbox} = authenticationWithMailbox();
	const signUp = await authentication.handler(
		postAuthentication("sign-up/email", {
			callbackURL: "/verify-email",
			email,
			password: AUTHENTICATION_PASSWORD,
		}),
	);
	if (signUp.status !== 200) {
		throw new Error(`expected sign-up 200, got ${signUp.status}`);
	}
	const verificationRequest = await authentication.handler(
		postAuthentication("send-verification-email", {callbackURL: "/verify-email", email}),
	);
	if (verificationRequest.status !== 200) {
		throw new Error(`expected verification email request 200, got ${verificationRequest.status}`);
	}
	const verificationEmail = required(mailbox[0], "verification email");
	const verification = await authentication.handler(new Request(emailLink(verificationEmail)));
	if (verification.status !== 302) {
		throw new Error(`expected verification 302, got ${verification.status}`);
	}
	const cookie = cookieFrom(verification);
	const session = await authentication.handler(
		new Request(`${API_ORIGIN}/api/auth/get-session`, {headers: {Cookie: cookie}}),
	);
	if (session.status !== 200) {
		throw new Error(`expected session 200, got ${session.status}`);
	}
	const body = await session.json<{user: {id: string}}>();
	return {cookie, userId: body.user.id};
}

export function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) {
		throw new Error(`missing ${label}`);
	}
	return value;
}

/**
 * An account whose agent-side caller holds a real device-authorized OAuth access token, with AFK
 * already on. Every suite that exercises the agent-facing routes starts here, so none of them can
 * pass with a credential the deployment would not actually issue.
 */
export async function authorizeAgentClient(userId: string): Promise<string> {
	const {accessToken} = await authorizeDeviceClient(userId);
	const result = await env.USER_DO.getByName(userId).setAfk(true, true);
	if (result.status !== "updated") {
		throw new Error("the authorized agent client could not enable AFK");
	}
	return accessToken;
}

export interface CreatedBatchResponse {
	batch_id: string;
	question_ids: string[];
}

export type BatchGitContext = Pick<CreateBatchRequest, "repo" | "branch" | "worktree" | "directory">;

export async function createBatchOverHttp(
	token: string,
	project: string,
	questions: Array<{title: string; body: string}>,
	context: BatchGitContext = {},
): Promise<CreatedBatchResponse> {
	const response = await worker.fetch(`${API_ORIGIN}/api/v1/questions`, {
		method: "POST",
		headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
		body: JSON.stringify({project, questions, ...context}),
	});
	if (response.status !== 201) {
		throw new Error(`expected 201, got ${response.status}`);
	}
	return response.json();
}

export async function postAnswers(
	token: string,
	answers: Array<{question_id: string; disposition: string}>,
): Promise<Response> {
	return worker.fetch(`${API_ORIGIN}/api/v1/answers`, {
		method: "POST",
		headers: {Authorization: `Bearer ${token}`},
		body: JSON.stringify({answers}),
	});
}

/**
 * 🧾 The durable outcome ledger, read straight from the row it lives in. Nothing in the product
 * aggregates it, so a suite that wants to know what happened asks for the outcomes themselves
 * rather than for counts some reporting layer derived.
 */
export async function questionOutcomes(userId: string): Promise<string[]> {
	return runInDurableObject(env.USER_DO.getByName(userId), (_instance: UserDurableObject, state) =>
		state.storage.sql
			.exec<{outcome: string}>("SELECT outcome FROM question_activity ORDER BY outcome")
			.toArray()
			.map(({outcome}) => outcome),
	);
}

export async function nextMessage(socket: WebSocket): Promise<string> {
	return new Promise((resolve, reject) => {
		socket.addEventListener(
			"message",
			(event) => {
				if (typeof event.data !== "string") {
					reject(new Error("expected a text frame"));
					return;
				}
				resolve(event.data);
			},
			{once: true},
		);
		socket.addEventListener(
			"error",
			() => {
				reject(new Error("websocket error"));
			},
			{once: true},
		);
	});
}
