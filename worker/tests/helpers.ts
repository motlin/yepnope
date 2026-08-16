import {env, exports} from "cloudflare:workers";
import {hashToken} from "../auth";
import type {CreateBatchRequest} from "../validation";

export const API_ORIGIN = "https://yepnope.app";

export const worker = exports.default;

export function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) {
		throw new Error(`missing ${label}`);
	}
	return value;
}

export async function registerMachineToken(userId: string): Promise<string> {
	const token = `machine-token-${userId}`;
	await env.DB.prepare("INSERT INTO machine_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)")
		.bind(await hashToken(token), userId, Date.now())
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
