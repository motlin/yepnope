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

const questionsResponseSchema = z.object({
	questions: z.array(
		z.object({
			batch_id: z.string(),
			project: z.string(),
			question_id: z.string(),
			position: z.number(),
			title: z.string(),
			body: z.string(),
			created_at: z.number(),
		}),
	),
});

export async function fetchQuestions(token: string): Promise<DeckQuestion[]> {
	const body = await requestJson("/api/v1/questions", {headers: authHeaders(token)}, questionsResponseSchema);
	return body.questions.map((question) => ({
		questionId: question.question_id,
		batchId: question.batch_id,
		project: question.project,
		title: question.title,
		body: question.body,
	}));
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
