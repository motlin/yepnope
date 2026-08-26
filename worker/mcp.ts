import {createMcpHandler, McpServer} from "@modelcontextprotocol/server";
import {z} from "zod";
import {
	ASK_YEP_NOPE_STANDARD_SCHEMA,
	formatAskYepNopeResult,
	NATIVE_QUESTION_FALLBACK,
	NATIVE_QUESTION_FALLBACK_TEXT,
	TOOL_DESCRIPTION,
	TOOL_NAME,
} from "./ask-tool";
import {OAUTH_SCOPES} from "./auth";
import {recordConnectedMcpClientUse} from "./connected-mcp-clients";
import {
	bearerToken,
	grantSessionId,
	hasActiveGrant,
	mcpResource,
	QUESTION_SCOPE,
	verifyAccessToken,
} from "./oauth-token";
import {parseFrame, type DispositionMap} from "./protocol";
import type {UserDurableObject} from "./user-do";
import {
	externalContextReferenceRejection,
	findExternalContextReferenceViolations,
	findLengthViolations,
	RETENTION_MILLISECONDS,
	teachingRejection,
	type Disposition,
} from "./validation";

const DEFAULT_HEARTBEAT_MILLISECONDS = 30_000;
const DEFAULT_PROGRESS_MILLISECONDS = 15_000;
const DEFAULT_RECONNECT_DELAY_MILLISECONDS = 2_000;
const DEFAULT_MAXIMUM_RECONNECT_DELAY_MILLISECONDS = 30_000;
const DEFAULT_MAXIMUM_CONSECUTIVE_FAILURES = 5;

const mcpRequestIdSchema = z.union([z.string(), z.number()]);
const mcpMessageSchema = z
	.object({
		id: mcpRequestIdSchema.optional(),
		method: z.string(),
		params: z.unknown().optional(),
	})
	.loose();
const mcpCancellationParamsSchema = z.object({requestId: mcpRequestIdSchema}).loose();

export interface RemoteMcpTiming {
	answerTimeoutMilliseconds: number;
	heartbeatMilliseconds: number;
	maximumConsecutiveFailures: number;
	maximumReconnectDelayMilliseconds: number;
	progressMilliseconds: number;
	reconnectDelayMilliseconds: number;
}

const DEFAULT_TIMING: RemoteMcpTiming = {
	answerTimeoutMilliseconds: RETENTION_MILLISECONDS,
	heartbeatMilliseconds: DEFAULT_HEARTBEAT_MILLISECONDS,
	maximumConsecutiveFailures: DEFAULT_MAXIMUM_CONSECUTIVE_FAILURES,
	maximumReconnectDelayMilliseconds: DEFAULT_MAXIMUM_RECONNECT_DELAY_MILLISECONDS,
	progressMilliseconds: DEFAULT_PROGRESS_MILLISECONDS,
	reconnectDelayMilliseconds: DEFAULT_RECONNECT_DELAY_MILLISECONDS,
};

type StreamResult =
	| {kind: "resolved"; dispositions: DispositionMap}
	| {kind: "error"; code: string; message: string}
	| {kind: "closed"; receivedState: boolean};

function textResult(text: string, isError: boolean) {
	return {content: [{type: "text" as const, text}], ...(isError ? {isError: true} : {})};
}

function nativeQuestionFallbackResult() {
	return {
		content: [{type: "text" as const, text: NATIVE_QUESTION_FALLBACK_TEXT}],
		structuredContent: NATIVE_QUESTION_FALLBACK,
	};
}

function invalidGrantResponse(resource: string): Response {
	const metadata = new URL("/.well-known/oauth-protected-resource/mcp", resource).toString();
	return Response.json(
		{jsonrpc: "2.0", error: {code: -32_000, message: "Invalid or revoked access token"}, id: null},
		{
			status: 401,
			headers: {
				"WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${metadata}"`,
			},
		},
	);
}

function authorizationChallenge(resource: string, insufficientScope: boolean): Response {
	const metadata = new URL("/.well-known/oauth-protected-resource/mcp", resource).toString();
	const challenge = insufficientScope
		? `Bearer error="insufficient_scope", scope="${QUESTION_SCOPE}", resource_metadata="${metadata}"`
		: `Bearer resource_metadata="${metadata}", scope="${OAUTH_SCOPES.join(" ")}"`;
	return Response.json(
		{
			jsonrpc: "2.0",
			error: {
				code: -32_000,
				message: insufficientScope ? "Access token has insufficient scope" : "Invalid or missing access token",
			},
			id: null,
		},
		{status: insufficientScope ? 403 : 401, headers: {"WWW-Authenticate": challenge}},
	);
}

function reconnectDelay(failures: number, timing: RemoteMcpTiming): number {
	return Math.min(timing.maximumReconnectDelayMilliseconds, timing.reconnectDelayMilliseconds * 2 ** (failures - 1));
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
	await new Promise<void>((resolve) => {
		const finish = (): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, milliseconds);
		signal.addEventListener("abort", finish, {once: true});
	});
}

async function openAnswerStream(
	stub: DurableObjectStub<UserDurableObject>,
	batchId: string,
	signal: AbortSignal,
	heartbeatMilliseconds: number,
	onState: (dispositions: DispositionMap) => void,
): Promise<StreamResult> {
	const response = await stub.fetch(
		new Request(`https://user-durable-object/api/v1/questions/${encodeURIComponent(batchId)}/stream`, {
			headers: {Upgrade: "websocket"},
		}),
	);
	const socket = response.webSocket;
	if (response.status !== 101 || socket === null) {
		return {kind: "closed", receivedState: false};
	}
	socket.accept();
	return new Promise((resolve) => {
		let receivedState = false;
		let settled = false;
		const heartbeat = setInterval(() => {
			socket.send(JSON.stringify({type: "heartbeat"}));
		}, heartbeatMilliseconds);
		const settle = (result: StreamResult): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearInterval(heartbeat);
			signal.removeEventListener("abort", onAbort);
			socket.close(1000, "MCP answer stream ended");
			resolve(result);
		};
		const onAbort = (): void => {
			settle({kind: "closed", receivedState});
		};
		signal.addEventListener("abort", onAbort, {once: true});
		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string") {
				return;
			}
			const frame = parseFrame(event.data);
			if (frame === null) {
				return;
			}
			if (frame.type === "state") {
				receivedState = true;
				onState(frame.dispositions);
				return;
			}
			if (frame.type === "resolved") {
				settle({kind: "resolved", dispositions: frame.dispositions});
				return;
			}
			settle({kind: "error", code: frame.code, message: frame.message});
		});
		socket.addEventListener("close", () => {
			settle({kind: "closed", receivedState});
		});
		socket.addEventListener("error", () => {
			settle({kind: "closed", receivedState});
		});
	});
}

async function waitForAnswers(
	stub: DurableObjectStub<UserDurableObject>,
	batchId: string,
	signal: AbortSignal,
	timing: RemoteMcpTiming,
	onState: (dispositions: DispositionMap) => void,
): Promise<StreamResult> {
	const deadline = Date.now() + timing.answerTimeoutMilliseconds;
	let failures = 0;
	for (;;) {
		if (signal.aborted) {
			throw new DOMException("MCP request cancelled", "AbortError");
		}
		if (Date.now() >= deadline) {
			return {
				kind: "error",
				code: "answer_timeout",
				message: "The ask_yep_nope call timed out before every question was answered.",
			};
		}
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const result = await Promise.race([
			openAnswerStream(stub, batchId, signal, timing.heartbeatMilliseconds, onState),
			new Promise<StreamResult>((resolve) => {
				timeout = setTimeout(
					() => {
						resolve({
							kind: "error",
							code: "answer_timeout",
							message: "The ask_yep_nope call timed out before every question was answered.",
						});
					},
					Math.max(0, deadline - Date.now()),
				);
			}),
		]);
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
		if (result.kind !== "closed") {
			return result;
		}
		failures = result.receivedState ? 1 : failures + 1;
		if (failures >= timing.maximumConsecutiveFailures) {
			return {
				kind: "error",
				code: "answer_stream_failed",
				message: `The yepnope answer stream stopped after ${String(timing.maximumConsecutiveFailures)} consecutive connection failures.`,
			};
		}
		await delay(reconnectDelay(failures, timing), signal);
	}
}

function orderedDispositions(questionIds: string[], dispositions: DispositionMap): Disposition[] | null {
	const ordered: Disposition[] = [];
	for (const questionId of questionIds) {
		const disposition = dispositions[questionId];
		if (disposition === null || disposition === undefined) {
			return null;
		}
		ordered.push(disposition);
	}
	return ordered;
}

function createRemoteMcpServer(
	stub: DurableObjectStub<UserDurableObject>,
	executionContext: ExecutionContext,
	timing: RemoteMcpTiming,
	requestKey: string | null,
): McpServer {
	const server = new McpServer({name: "yepnope", version: "0.1.0"});
	server.registerTool(
		TOOL_NAME,
		{description: TOOL_DESCRIPTION, inputSchema: ASK_YEP_NOPE_STANDARD_SCHEMA},
		async (batch, context) => {
			const violations = findLengthViolations(batch.questions);
			if (violations.length > 0) {
				return textResult(teachingRejection(violations), true);
			}
			const externalContextReferences = findExternalContextReferenceViolations(batch.questions);
			if (externalContextReferences.length > 0) {
				return textResult(externalContextReferenceRejection(externalContextReferences), true);
			}
			if (!(await stub.getAfk(true))) {
				return nativeQuestionFallbackResult();
			}
			const created = await stub.createBatch(batch);
			if (requestKey !== null) {
				await stub.registerMcpRequest(requestKey, created.batchId);
			}
			executionContext.waitUntil(stub.sendBatchPush(created.batchId));
			let completed = false;
			let latest: DispositionMap = {};
			const progressToken = context.mcpReq._meta?.progressToken;
			const progress = setInterval(() => {
				if (progressToken === undefined) {
					return;
				}
				const answered = Object.values(latest).filter((disposition) => disposition !== null).length;
				void context.mcpReq
					.notify({
						method: "notifications/progress",
						params: {
							progressToken,
							progress: answered,
							total: created.questionIds.length,
							message: `Waiting on the user's phone: ${String(answered)} of ${String(created.questionIds.length)} answered. Answers may take hours.`,
						},
					})
					.catch(() => undefined);
			}, timing.progressMilliseconds);
			try {
				const result = await waitForAnswers(stub, created.batchId, context.mcpReq.signal, timing, (state) => {
					latest = state;
				});
				if (result.kind === "resolved") {
					const dispositions = orderedDispositions(created.questionIds, result.dispositions);
					if (dispositions === null) {
						return textResult("The batch resolved without one disposition per question.", true);
					}
					completed = true;
					return textResult(formatAskYepNopeResult(batch.questions, dispositions), false);
				}
				if (result.kind === "closed") {
					throw new Error("answer stream loop returned an unresolved closed connection");
				}
				return textResult(result.message, true);
			} finally {
				clearInterval(progress);
				if (!completed) {
					await stub.retractBatch(created.batchId);
				}
				if (requestKey !== null) {
					await stub.unregisterMcpRequest(requestKey, created.batchId);
				}
			}
		},
	);
	return server;
}

export async function handleRemoteMcpRequest(
	request: Request,
	environment: Env,
	executionContext: ExecutionContext,
	timing: RemoteMcpTiming = DEFAULT_TIMING,
): Promise<Response> {
	const resource = mcpResource(environment);
	const token = bearerToken(request);
	if (token === null) {
		return authorizationChallenge(resource, false);
	}
	const claims = await verifyAccessToken(token, environment, executionContext);
	if (claims === null) {
		return authorizationChallenge(resource, false);
	}
	const grantedScopes = new Set(claims.scope.split(" "));
	if (!grantedScopes.has(QUESTION_SCOPE)) {
		return authorizationChallenge(resource, true);
	}
	if (!(await hasActiveGrant(environment.DB, claims, resource))) {
		return invalidGrantResponse(resource);
	}
	await recordConnectedMcpClientUse(environment.DB, claims.sub, claims.client_id, Date.now());
	const message = mcpMessageSchema.safeParse(
		await request
			.clone()
			.json()
			.catch(() => null),
	);
	// 🧵 A cancellation arrives as its own request, so the key it looks up has to outlive a token
	// refresh: the client, the session the grant came from, and the JSON-RPC id. A device grant has no
	// session, so the account it was approved for stands in — one such client per install.
	const grantKey = `${claims.client_id}:${grantSessionId(claims) ?? claims.sub}`;
	const requestKey =
		message.success && message.data.id !== undefined ? `${grantKey}:${String(message.data.id)}` : null;
	const cancellation =
		message.success && message.data.method === "notifications/cancelled"
			? mcpCancellationParamsSchema.safeParse(message.data.params)
			: null;
	if (cancellation?.success === true) {
		await environment.USER_DO.getByName(claims.sub).cancelMcpRequest(
			`${grantKey}:${String(cancellation.data.requestId)}`,
		);
	}
	const handler = createMcpHandler(
		() => createRemoteMcpServer(environment.USER_DO.getByName(claims.sub), executionContext, timing, requestKey),
		{responseMode: "sse"},
	);
	return handler.fetch(request);
}
