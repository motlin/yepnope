import {z} from "zod";
import type {DeckQuestion, Disposition} from "./deck";

// 🌐 Thin client for the Worker API. Same-origin in production; the dev server proxies /api.

async function requestJson<Schema extends z.ZodType>(
	path: string,
	init: RequestInit,
	schema: Schema,
): Promise<z.infer<Schema>> {
	const response = await fetch(path, init);
	if (!response.ok) {
		throw new Error(`${init.method ?? "GET"} ${path} failed with ${response.status}`);
	}
	const body: unknown = await response.json();
	return schema.parse(body);
}

function authHeaders(token: string): Record<string, string> {
	return {Authorization: `Bearer ${token}`};
}

const pairNewResponseSchema = z.object({token: z.string()});

export async function pairNew(): Promise<string> {
	const body = await requestJson("/api/v1/pair/new", {method: "POST"}, pairNewResponseSchema);
	return body.token;
}

const pairCodeResponseSchema = z.object({code: z.string(), expires_at: z.number()});

export interface IssuedPairingCode {
	code: string;
	expiresAt: number;
}

export async function issuePairingCode(token: string): Promise<IssuedPairingCode> {
	const body = await requestJson(
		"/api/v1/pair/code",
		{method: "POST", headers: authHeaders(token)},
		pairCodeResponseSchema,
	);
	return {code: body.code, expiresAt: body.expires_at};
}

const pairingStatusResponseSchema = z.object({paired: z.boolean(), machine_count: z.number().int().nonnegative()});

export interface PairingStatus {
	paired: boolean;
	machineCount: number;
}

export async function fetchPairingStatus(token: string): Promise<PairingStatus> {
	const body = await requestJson("/api/v1/pair/status", {headers: authHeaders(token)}, pairingStatusResponseSchema);
	return {paired: body.paired, machineCount: body.machine_count};
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

export function openQuestionsStream(token: string, onQuestions: (questions: DeckQuestion[]) => void): QuestionsStream {
	let socket: WebSocket | null = null;
	let reconnectTimer: number | undefined;
	let stopped = false;

	function connect(): void {
		const url = new URL("/api/v1/questions/stream", window.location.href);
		url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		socket = new WebSocket(url, ["yepnope", token]);
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

export async function submitAnswer(token: string, questionId: string, disposition: Disposition): Promise<void> {
	await requestJson(
		"/api/v1/answers",
		{
			method: "POST",
			headers: authHeaders(token),
			body: JSON.stringify({answers: [{question_id: questionId, disposition}]}),
		},
		okResponseSchema,
	);
}

const afkResponseSchema = z.object({afk: z.boolean()});

export async function fetchAfk(token: string): Promise<boolean> {
	const body = await requestJson("/api/v1/afk", {headers: authHeaders(token)}, afkResponseSchema);
	return body.afk;
}

export async function updateAfk(token: string, afk: boolean): Promise<boolean> {
	const body = await requestJson(
		"/api/v1/afk",
		{method: "PUT", headers: authHeaders(token), body: JSON.stringify({afk})},
		afkResponseSchema,
	);
	return body.afk;
}

const publicKeyResponseSchema = z.object({public_key: z.string()});

export async function fetchVapidPublicKey(): Promise<string> {
	const body = await requestJson("/api/v1/push/public-key", {}, publicKeyResponseSchema);
	return body.public_key;
}

export async function registerPushSubscription(token: string, subscription: unknown): Promise<void> {
	await requestJson(
		"/api/v1/push/subscribe",
		{method: "POST", headers: authHeaders(token), body: JSON.stringify(subscription)},
		okResponseSchema,
	);
}
