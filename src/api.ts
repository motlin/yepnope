import {z} from "zod";
import type {DeckQuestion, Disposition} from "./deck";

// 🌐 Thin client for the Worker API. Same-origin in production; the dev server proxies /api.

async function requestJson<Schema extends z.ZodType>(
	path: string,
	init: RequestInit,
	schema: Schema,
): Promise<z.infer<Schema>> {
	const response = await fetch(path, {credentials: "same-origin", ...init});
	if (!response.ok) {
		const error = z.object({message: z.string()}).safeParse(
			await response
				.clone()
				.json()
				.catch(() => null),
		);
		throw new Error(
			error.success ? error.data.message : `${init.method ?? "GET"} ${path} failed with ${response.status}`,
		);
	}
	const body: unknown = await response.json();
	return schema.parse(body);
}

function jsonRequest(body: Record<string, unknown>): RequestInit {
	return {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify(body),
	};
}

const authenticationUserSchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.email(),
	emailVerified: z.boolean(),
});

export type AuthenticationUser = z.infer<typeof authenticationUserSchema>;

const sessionResponseSchema = z.object({user: authenticationUserSchema}).nullable();

export async function fetchSession(): Promise<AuthenticationUser | null> {
	const session = await requestJson("/api/auth/get-session", {}, sessionResponseSchema);
	return session?.user ?? null;
}

const authenticatedResponseSchema = z.object({user: authenticationUserSchema});

export async function signIn(email: string, password: string): Promise<AuthenticationUser> {
	const result = await requestJson(
		"/api/auth/sign-in/email",
		jsonRequest({email, password}),
		authenticatedResponseSchema,
	);
	return result.user;
}

export async function registerAccount(name: string, email: string, password: string): Promise<AuthenticationUser> {
	const result = await requestJson(
		"/api/auth/sign-up/email",
		jsonRequest({name, email, password, callbackURL: "/verify-email?verified=1"}),
		authenticatedResponseSchema,
	);
	return result.user;
}

const successResponseSchema = z.object({status: z.literal(true)});

export async function sendVerificationEmail(email: string): Promise<void> {
	await requestJson(
		"/api/auth/send-verification-email",
		jsonRequest({email, callbackURL: "/verify-email?verified=1"}),
		successResponseSchema,
	);
}

export async function requestPasswordReset(email: string): Promise<void> {
	await requestJson(
		"/api/auth/request-password-reset",
		jsonRequest({email, redirectTo: "/reset-password"}),
		z.object({status: z.literal(true), message: z.string()}),
	);
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
	await requestJson("/api/auth/reset-password", jsonRequest({token, newPassword}), successResponseSchema);
}

export async function signOut(): Promise<void> {
	await requestJson("/api/auth/sign-out", jsonRequest({}), z.object({success: z.literal(true)}));
}

const pairCodeResponseSchema = z.object({code: z.string(), expires_at: z.number()});

export interface IssuedPairingCode {
	code: string;
	expiresAt: number;
}

export async function issuePairingCode(): Promise<IssuedPairingCode> {
	const body = await requestJson("/api/v1/pair/code", {method: "POST"}, pairCodeResponseSchema);
	return {code: body.code, expiresAt: body.expires_at};
}

const pairingStatusResponseSchema = z.object({paired: z.boolean(), machine_count: z.number().int().nonnegative()});

export interface PairingStatus {
	paired: boolean;
	machineCount: number;
}

export async function fetchPairingStatus(): Promise<PairingStatus> {
	const body = await requestJson("/api/v1/pair/status", {}, pairingStatusResponseSchema);
	return {paired: body.paired, machineCount: body.machine_count};
}

const legacyIdentityClaimResponseSchema = z.object({
	status: z.literal("claimed"),
	already_claimed: z.boolean(),
});

export async function claimLegacyIdentity(legacyToken: string): Promise<void> {
	await requestJson(
		"/api/v1/account/claim-legacy",
		jsonRequest({legacy_token: legacyToken}),
		legacyIdentityClaimResponseSchema,
	);
}

const questionSchema = z.object({
	batch_id: z.string(),
	project: z.string(),
	repo: z.string().nullable(),
	branch: z.string().nullable(),
	directory: z.string().nullable(),
	question_id: z.string(),
	position: z.number(),
	title: z.string(),
	body: z.string(),
	created_at: z.number(),
});

const questionsStateSchema = z.object({type: z.literal("questions"), questions: z.array(questionSchema)});

function toDeckQuestions(questions: z.infer<typeof questionSchema>[]): DeckQuestion[] {
	return questions.map((question) => ({
		questionId: question.question_id,
		batchId: question.batch_id,
		project: question.project,
		repo: question.repo,
		branch: question.branch,
		directory: question.directory,
		title: question.title,
		body: question.body,
	}));
}

export interface QuestionsStream {
	close: () => void;
	refresh: () => void;
}

export function openQuestionsStream(onQuestions: (questions: DeckQuestion[]) => void): QuestionsStream {
	let socket: WebSocket | null = null;
	let reconnectTimer: number | undefined;
	let stopped = false;

	function connect(): void {
		const url = new URL("/api/v1/questions/stream", window.location.href);
		url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		socket = new WebSocket(url);
		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string") {
				throw new Error("question stream sent a non-text frame");
			}
			const state = questionsStateSchema.parse(JSON.parse(event.data) as unknown);
			onQuestions(toDeckQuestions(state.questions));
		});
		socket.addEventListener("close", () => {
			if (!stopped) {
				reconnectTimer = window.setTimeout(connect, 1000);
			}
		});
	}

	connect();
	return {
		close: () => {
			stopped = true;
			if (reconnectTimer !== undefined) {
				window.clearTimeout(reconnectTimer);
			}
			socket?.close();
		},
		refresh: () => {
			if (socket?.readyState === WebSocket.OPEN) {
				socket.send("state");
			}
		},
	};
}

const okResponseSchema = z.object({status: z.string()});

export async function submitAnswer(questionId: string, disposition: Disposition): Promise<void> {
	await requestJson(
		"/api/v1/answers",
		{
			method: "POST",
			headers: {"Content-Type": "application/json"},
			body: JSON.stringify({answers: [{question_id: questionId, disposition}]}),
		},
		okResponseSchema,
	);
}

const afkResponseSchema = z.object({afk: z.boolean()});

export async function fetchAfk(): Promise<boolean> {
	const body = await requestJson("/api/v1/afk", {}, afkResponseSchema);
	return body.afk;
}

export async function updateAfk(afk: boolean): Promise<boolean> {
	const body = await requestJson(
		"/api/v1/afk",
		{method: "PUT", headers: {"Content-Type": "application/json"}, body: JSON.stringify({afk})},
		afkResponseSchema,
	);
	return body.afk;
}

const publicKeyResponseSchema = z.object({public_key: z.string()});

export async function fetchVapidPublicKey(): Promise<string> {
	const body = await requestJson("/api/v1/push/public-key", {}, publicKeyResponseSchema);
	return body.public_key;
}

export async function registerPushSubscription(subscription: unknown): Promise<void> {
	await requestJson(
		"/api/v1/push/subscribe",
		{method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(subscription)},
		okResponseSchema,
	);
}
