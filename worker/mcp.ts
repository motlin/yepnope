import {createMcpHandler, McpServer} from "@modelcontextprotocol/server";
import {createLocalJWKSet, jwtVerify} from "jose";
import {z} from "zod";
import {ASK_YEP_NOPE_STANDARD_SCHEMA, formatAskYepNopeResult, TOOL_DESCRIPTION, TOOL_NAME} from "../shim/tool";
import {createWorkerAuthentication, MCP_RESOURCE_PATH, OAUTH_SCOPES} from "./auth";
import {emitObservation, type ObservationContext} from "./observability";
import {parseFrame, type DispositionMap} from "./protocol";
import type {UserDurableObject} from "./user-do";
import {findLengthViolations, RETENTION_MILLISECONDS, teachingRejection, type Disposition} from "./validation";

const QUESTION_SCOPE = "yepnope:questions";
const AFK_SCOPE = "yepnope:afk";
const AFK_TOOL_NAME = "set_yepnope_afk";
const DEFAULT_HEARTBEAT_MILLISECONDS = 30_000;
const DEFAULT_PROGRESS_MILLISECONDS = 15_000;
const DEFAULT_RECONNECT_DELAY_MILLISECONDS = 2_000;
const DEFAULT_MAXIMUM_RECONNECT_DELAY_MILLISECONDS = 30_000;
const DEFAULT_MAXIMUM_CONSECUTIVE_FAILURES = 5;

const accessTokenClaimsSchema = z
	.object({
		azp: z.string().min(1),
		client_id: z.string().min(1),
		exp: z.number().int(),
		iat: z.number().int(),
		jti: z.string().min(1),
		scope: z.string().min(1),
		sid: z.string().min(1),
		sub: z.string().min(1),
	})
	.loose();

const stringArraySchema = z.array(z.string());
const jsonWebKeySetSchema = z.object({keys: z.array(z.record(z.string(), z.unknown()))});

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

interface ActiveGrantRow {
	consent_resources: string | null;
	consent_scopes: string;
	refresh_resources: string | null;
	refresh_scopes: string;
}

type StreamResult =
	| {kind: "resolved"; dispositions: DispositionMap}
	| {kind: "error"; code: string; message: string}
	| {kind: "closed"; receivedState: boolean};

function textResult(text: string, isError: boolean) {
	return {content: [{type: "text" as const, text}], ...(isError ? {isError: true} : {})};
}

function parseStoredStringArray(value: string | null): string[] {
	return value === null ? [] : stringArraySchema.parse(JSON.parse(value) as unknown);
}

async function hasActiveGrant(
	database: D1Database,
	claims: z.infer<typeof accessTokenClaimsSchema>,
	resource: string,
): Promise<boolean> {
	if (claims.azp !== claims.client_id) {
		return false;
	}
	const now = Date.now();
	const rows = await database
		.prepare(
			"SELECT refresh.resources AS refresh_resources, refresh.scopes AS refresh_scopes, " +
				"consent.resources AS consent_resources, consent.scopes AS consent_scopes " +
				"FROM oauth_refresh_token AS refresh " +
				"JOIN oauth_client AS client ON client.client_id = refresh.client_id " +
				"JOIN session ON session.id = refresh.session_id " +
				"JOIN user ON user.id = refresh.user_id " +
				"JOIN oauth_consent AS consent ON consent.client_id = refresh.client_id AND consent.user_id = refresh.user_id " +
				"WHERE refresh.user_id = ? AND refresh.client_id = ? AND refresh.session_id = ? " +
				"AND refresh.revoked IS NULL AND refresh.expires_at > ? " +
				"AND COALESCE(client.disabled, 0) = 0 AND session.user_id = ? AND session.expires_at > ? " +
				"AND user.email_verified = 1",
		)
		.bind(claims.sub, claims.client_id, claims.sid, now, claims.sub, now)
		.all<ActiveGrantRow>();
	const tokenScopes = new Set(claims.scope.split(" "));
	return rows.results.some((row) => {
		const refreshScopes = new Set(parseStoredStringArray(row.refresh_scopes));
		const consentScopes = new Set(parseStoredStringArray(row.consent_scopes));
		return (
			parseStoredStringArray(row.refresh_resources).includes(resource) &&
			parseStoredStringArray(row.consent_resources).includes(resource) &&
			tokenScopes.has(QUESTION_SCOPE) &&
			refreshScopes.has(QUESTION_SCOPE) &&
			consentScopes.has(QUESTION_SCOPE)
		);
	});
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

function bearerToken(request: Request): string | null {
	const authorization = request.headers.get("Authorization");
	if (authorization === null || !authorization.startsWith("Bearer ")) {
		return null;
	}
	const token = authorization.slice("Bearer ".length);
	return token.length === 0 || token.includes(" ") ? null : token;
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
	grantedScopes: ReadonlySet<string>,
	executionContext: ExecutionContext,
	observationContext: ObservationContext,
	timing: RemoteMcpTiming,
): McpServer {
	const server = new McpServer({name: "yepnope", version: "0.1.0"});
	server.registerTool(
		TOOL_NAME,
		{description: TOOL_DESCRIPTION, inputSchema: ASK_YEP_NOPE_STANDARD_SCHEMA},
		async (batch, context) => {
			emitObservation(observationContext, "mcp.tool", "input", {
				questionCount: batch.questions.length,
				tool: TOOL_NAME,
			});
			const violations = findLengthViolations(batch.questions);
			if (violations.length > 0) {
				emitObservation(observationContext, "mcp.tool", "output", {
					outcome: "validation_error",
					tool: TOOL_NAME,
				});
				return textResult(teachingRejection(violations), true);
			}
			if (!(await stub.getAfk(true))) {
				emitObservation(observationContext, "mcp.tool", "output", {outcome: "afk_off", tool: TOOL_NAME});
				return textResult(
					"The user is at their keyboard, so questions are not being routed to their phone. " +
						"Use the AskUserQuestion tool instead of ask_yep_nope for this question.",
					true,
				);
			}
			const created = await stub.createBatch(batch);
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
					emitObservation(observationContext, "mcp.tool", "output", {
						outcome: "answered",
						questionCount: dispositions.length,
						tool: TOOL_NAME,
					});
					return textResult(formatAskYepNopeResult(batch.questions, dispositions), false);
				}
				if (result.kind === "closed") {
					throw new Error("answer stream loop returned an unresolved closed connection");
				}
				emitObservation(observationContext, "mcp.tool", "output", {outcome: result.code, tool: TOOL_NAME});
				return textResult(result.message, true);
			} finally {
				clearInterval(progress);
				if (!completed) {
					await stub.retractBatch(created.batchId);
				}
			}
		},
	);
	server.registerTool(
		AFK_TOOL_NAME,
		{
			description: "Turn YepNope phone routing on or off for this account.",
			inputSchema: z.object({afk: z.boolean()}),
		},
		async ({afk}) => {
			if (!grantedScopes.has(AFK_SCOPE)) {
				return textResult("This OAuth client does not have the yepnope:afk scope.", true);
			}
			const result = await stub.setAfk(afk, true);
			emitObservation(observationContext, "mcp.tool", "output", {
				afk,
				outcome: result.status,
				tool: AFK_TOOL_NAME,
			});
			if (result.status !== "updated") {
				return textResult(result.message, true);
			}
			return textResult(`AFK routing is ${result.afk ? "on" : "off"}.`, false);
		},
	);
	return server;
}

export async function handleRemoteMcpRequest(
	request: Request,
	environment: Env,
	executionContext: ExecutionContext,
	observationContext: ObservationContext,
	timing: RemoteMcpTiming = DEFAULT_TIMING,
): Promise<Response> {
	const resource = `${environment.BETTER_AUTH_URL}${MCP_RESOURCE_PATH}`;
	const issuer = `${environment.BETTER_AUTH_URL}/api/auth`;
	const authentication = createWorkerAuthentication(environment, executionContext);
	const token = bearerToken(request);
	if (token === null) {
		emitObservation(observationContext, "mcp.authentication", "output", {outcome: "missing_token"});
		return authorizationChallenge(resource, false);
	}
	let untrustedClaims: unknown;
	try {
		const jwksResponse = await authentication.handler(new Request(`${issuer}/jwks`));
		if (!jwksResponse.ok) {
			throw new Error("Better Auth JWKS endpoint failed");
		}
		const jwks = jsonWebKeySetSchema.parse(await jwksResponse.json());
		const verified = await jwtVerify(token, createLocalJWKSet(jwks), {audience: resource, issuer});
		untrustedClaims = verified.payload;
	} catch {
		emitObservation(observationContext, "mcp.authentication", "output", {outcome: "invalid_token"});
		return authorizationChallenge(resource, false);
	}
	const parsed = accessTokenClaimsSchema.safeParse(untrustedClaims);
	if (!parsed.success) {
		emitObservation(observationContext, "mcp.authentication", "output", {outcome: "invalid_claims"});
		return authorizationChallenge(resource, false);
	}
	const grantedScopes = new Set(parsed.data.scope.split(" "));
	if (!grantedScopes.has(QUESTION_SCOPE)) {
		emitObservation(observationContext, "mcp.authentication", "output", {outcome: "insufficient_scope"});
		return authorizationChallenge(resource, true);
	}
	if (!(await hasActiveGrant(environment.DB, parsed.data, resource))) {
		emitObservation(observationContext, "mcp.authentication", "output", {outcome: "invalid_grant"});
		return invalidGrantResponse(resource);
	}
	const handler = createMcpHandler(
		() =>
			createRemoteMcpServer(
				environment.USER_DO.getByName(parsed.data.sub),
				grantedScopes,
				executionContext,
				observationContext,
				timing,
			),
		{responseMode: "sse"},
	);
	emitObservation(observationContext, "mcp.authentication", "output", {outcome: "accepted"});
	return handler.fetch(request);
}
