import {env, exports} from "cloudflare:workers";
import {createAuthentication, hashToken} from "../auth";
import type {CreateBatchRequest} from "../validation";

export const API_ORIGIN = "https://yepnope.app";

export const worker = exports.default;

const AUTHENTICATION_PASSWORD = "correct-horse-battery-staple";

interface DeliveredAuthenticationEmail {
	subject: string;
	text: string;
}

function authenticationWithMailbox(mailbox: DeliveredAuthenticationEmail[]) {
	return createAuthentication(env, {
		runInBackground: undefined,
		sendEmail: async (message) => {
			if (message.text === undefined) {
				throw new Error("authentication email is missing its text body");
			}
			await Promise.resolve(mailbox.push({subject: message.subject, text: message.text}));
		},
	});
}

function authenticationRequest(path: string, body: Record<string, string>): Request {
	return new Request(`${API_ORIGIN}/api/auth/${path}`, {
		method: "POST",
		headers: {"Content-Type": "application/json", Origin: API_ORIGIN},
		body: JSON.stringify(body),
	});
}

export function cookieFrom(response: Response): string {
	const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
	return required(cookie, "session cookie");
}

export function emailLink(email: DeliveredAuthenticationEmail): string {
	const url = /https:\/\/\S+/.exec(email.text)?.[0];
	return required(url, "authentication email link");
}

export async function createVerifiedBrowserSession(
	email = `alice-${crypto.randomUUID()}@example.com`,
): Promise<{cookie: string; userId: string}> {
	const mailbox: DeliveredAuthenticationEmail[] = [];
	const authentication = authenticationWithMailbox(mailbox);
	const signUp = await authentication.handler(
		authenticationRequest("sign-up/email", {
			callbackURL: "/",
			email,
			name: "Alice",
			password: AUTHENTICATION_PASSWORD,
		}),
	);
	if (signUp.status !== 200) {
		throw new Error(`expected sign-up 200, got ${signUp.status}`);
	}
	const verificationEmail = required(mailbox[0], "verification email");
	const verification = await authentication.handler(new Request(emailLink(verificationEmail)));
	if (verification.status !== 302) {
		throw new Error(`expected verification 302, got ${verification.status}`);
	}
	const signIn = await authentication.handler(
		authenticationRequest("sign-in/email", {email, password: AUTHENTICATION_PASSWORD}),
	);
	if (signIn.status !== 200) {
		throw new Error(`expected sign-in 200, got ${signIn.status}`);
	}
	const body = await signIn.clone().json<{user: {id: string}}>();
	return {cookie: cookieFrom(signIn), userId: body.user.id};
}

export function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) {
		throw new Error(`missing ${label}`);
	}
	return value;
}

export async function registerMachineToken(userId: string): Promise<string> {
	const token = `machine-token-${userId}`;
	const now = Date.now();
	await env.DB.prepare(
		"INSERT OR IGNORE INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
	)
		.bind(userId, userId, `${userId}@example.com`, now, now)
		.run();
	await env.DB.prepare("INSERT INTO machine_tokens (token_hash, user_id, label, created_at) VALUES (?, ?, ?, ?)")
		.bind(await hashToken(token), userId, "test machine", now)
		.run();
	return token;
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
