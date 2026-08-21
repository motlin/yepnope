import {createExecutionContext, runInDurableObject} from "cloudflare:test";
import {env} from "cloudflare:workers";
import {decodeJwt} from "jose";
import {afterEach, describe, expect, it, vi} from "vitest";
import {MCP_RESOURCE_PATH, OAUTH_SCOPES, workerAuthentication} from "../auth";
import {handleRemoteMcpRequest, type RemoteMcpTiming} from "../mcp";
import type {CurrentQuestion, UserDurableObject} from "../user-do";
import {
	NATIVE_QUESTION_FALLBACK,
	NATIVE_QUESTION_FALLBACK_TEXT,
	TOOL_DESCRIPTION,
	TOOL_INPUT_SCHEMA,
} from "../ask-tool";
import {API_ORIGIN, createVerifiedBrowserSession, questionOutcomes, required, worker} from "./helpers";
import {authorizeMcpHostClient} from "./oauth-client-helpers";

const ISSUER = `${API_ORIGIN}/api/auth`;
const RESOURCE = `${API_ORIGIN}${MCP_RESOURCE_PATH}`;
const TEST_TIMING: RemoteMcpTiming = {
	answerTimeoutMilliseconds: 500,
	heartbeatMilliseconds: 20,
	maximumConsecutiveFailures: 3,
	maximumReconnectDelayMilliseconds: 20,
	progressMilliseconds: 20,
	reconnectDelayMilliseconds: 5,
};

interface IssuedGrant {
	accessToken: string;
	clientId: string;
	refreshToken: string;
	userId: string;
}

interface McpResponse {
	id: number;
	jsonrpc: "2.0";
	result: {content: Array<{text: string; type: "text"}>; isError?: true};
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function issueGrant(email: string): Promise<IssuedGrant> {
	const {cookie, userId} = await createVerifiedBrowserSession(email);
	const {accessToken, clientId, refreshToken} = await authorizeMcpHostClient(cookie, "MCP endpoint test client");
	return {accessToken, clientId, refreshToken, userId};
}

function mcpRequest(
	accessToken: string,
	method: string,
	params?: Record<string, unknown>,
	signal?: AbortSignal,
): Request {
	return new Request(`${API_ORIGIN}/mcp`, {
		method: "POST",
		headers: {
			Accept: "application/json, text/event-stream",
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			"MCP-Protocol-Version": "2025-11-25",
		},
		body: JSON.stringify({id: 1, jsonrpc: "2.0", method, ...(params === undefined ? {} : {params})}),
		...(signal === undefined ? {} : {signal}),
	});
}

function askRequest(accessToken: string, signal?: AbortSignal): Request {
	return mcpRequest(
		accessToken,
		"tools/call",
		{
			arguments: {
				project: "Example project",
				questions: [
					{body: "The release candidate passed validation.", title: "Ship it?"},
					{body: "The legacy path is still in use.", title: "Delete it?"},
					{body: "The optional migration can wait.", title: "Migrate it?"},
				],
			},
			name: "ask_yep_nope",
		},
		signal,
	);
}

async function responseMessage(response: Response): Promise<unknown> {
	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) {
		return response.json();
	}
	const text = await response.text();
	const data = /^data: (.+)$/m.exec(text)?.[1];
	if (data === undefined) {
		throw new Error("MCP SSE response contained no data event");
	}
	return JSON.parse(data) as unknown;
}

async function remoteResponse(request: Request, timing: RemoteMcpTiming = TEST_TIMING): Promise<Response> {
	return handleRemoteMcpRequest(request, env, createExecutionContext(), timing);
}

async function waitForQuestionCount(userId: string, count: number): Promise<CurrentQuestion[]> {
	const stub = env.USER_DO.getByName(userId);
	const deadline = Date.now() + 2_000;
	for (;;) {
		const questions = await stub.getCurrentQuestions();
		if (questions.length === count) {
			return questions;
		}
		if (Date.now() >= deadline) {
			throw new Error(`expected ${String(count)} outstanding questions, found ${String(questions.length)}`);
		}
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 5);
		});
	}
}

async function closeAnswerSocket(stub: DurableObjectStub<UserDurableObject>, batchId: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	for (;;) {
		const closed = await runInDurableObject(stub, (_instance, state) => {
			const socket = state.getWebSockets(batchId)[0];
			if (socket === undefined) {
				return false;
			}
			socket.close(1012, "test reconnect");
			return true;
		});
		if (closed) {
			return;
		}
		if (Date.now() >= deadline) {
			throw new Error("missing initial MCP answer socket");
		}
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 5);
		});
	}
}

function strictTextResponse(text: string, isError = false): McpResponse {
	return {
		id: 1,
		jsonrpc: "2.0",
		result: {content: [{text, type: "text"}], ...(isError ? {isError: true as const} : {})},
	};
}

async function signClaims(claims: Record<string, unknown>): Promise<string> {
	const authentication = workerAuthentication(env);
	// oxlint-disable typescript/no-unsafe-call -- Better Auth 1.7 loses jwt API inference with its MCP plugin types.
	// @ts-expect-error Better Auth 1.7 loses jwt API inference when combined with its MCP plugin types.
	const signed: unknown = await authentication.api.signJWT({body: {payload: claims}});
	// oxlint-enable typescript/no-unsafe-call
	if (typeof signed !== "object" || signed === null || !("token" in signed) || typeof signed.token !== "string") {
		throw new Error("Better Auth JWT signing returned no token");
	}
	return signed.token;
}

describe("OAuth-authenticated remote MCP endpoint", () => {
	it("publishes one question tool and returns a typed native fallback while AFK is off", async () => {
		const grant = await issueGrant("mcp-contract-alice@example.com");
		const listed = await responseMessage(await worker.fetch(mcpRequest(grant.accessToken, "tools/list")));
		expect(listed).toStrictEqual({
			id: 1,
			jsonrpc: "2.0",
			result: {
				tools: [{name: "ask_yep_nope", description: TOOL_DESCRIPTION, inputSchema: TOOL_INPUT_SCHEMA}],
			},
		});

		const response = await worker.fetch(askRequest(grant.accessToken));
		expect({message: await responseMessage(response), status: response.status}).toStrictEqual({
			message: {
				id: 1,
				jsonrpc: "2.0",
				result: {
					content: [{text: NATIVE_QUESTION_FALLBACK_TEXT, type: "text"}],
					structuredContent: NATIVE_QUESTION_FALLBACK,
				},
			},
			status: 200,
		});
		const tooLong = await worker.fetch(
			mcpRequest(grant.accessToken, "tools/call", {
				arguments: {project: "Example project", questions: [{body: "", title: "x".repeat(101)}]},
				name: "ask_yep_nope",
			}),
		);
		expect(await responseMessage(tooLong)).toStrictEqual(
			strictTextResponse(
				"questions[0].title is 101 characters; the limit is 100. " +
					"Titles fit in 100 characters and bodies in 800. " +
					"Rewrite the over-length questions shorter and resend the whole batch; nothing is truncated for you.",
				true,
			),
		);
		expect(await env.USER_DO.getByName(grant.userId).getAfk(true)).toBe(false);
	});

	it("routes only to the token subject and returns one exact Yep, Nope, or Skip result per question", async () => {
		const alice = await issueGrant("mcp-isolation-alice@example.com");
		const bob = await issueGrant("mcp-isolation-bob@example.com");
		const bobStub = env.USER_DO.getByName(bob.userId);
		await bobStub.setAfk(true, true);

		const responsePromise = remoteResponse(askRequest(bob.accessToken));
		const questions = await waitForQuestionCount(bob.userId, 3);
		expect(await env.USER_DO.getByName(alice.userId).getCurrentQuestions()).toStrictEqual([]);
		expect(
			questions.map(({body, branch, directory, position, project, repo, title}) => ({
				body,
				branch,
				directory,
				position,
				project,
				repo,
				title,
			})),
		).toStrictEqual([
			{
				body: "The release candidate passed validation.",
				branch: null,
				directory: null,
				position: 0,
				project: "Example project",
				repo: null,
				title: "Ship it?",
			},
			{
				body: "The legacy path is still in use.",
				branch: null,
				directory: null,
				position: 1,
				project: "Example project",
				repo: null,
				title: "Delete it?",
			},
			{
				body: "The optional migration can wait.",
				branch: null,
				directory: null,
				position: 2,
				project: "Example project",
				repo: null,
				title: "Migrate it?",
			},
		]);
		await bobStub.submitAnswers([
			{question_id: required(questions[0], "first question").questionId, disposition: "yep"},
			{question_id: required(questions[1], "second question").questionId, disposition: "nope"},
			{question_id: required(questions[2], "third question").questionId, disposition: "skip"},
		]);
		expect(await responseMessage(await responsePromise)).toStrictEqual(
			strictTextResponse(
				"Ship it? -> YEP\n" +
					"Delete it? -> NOPE\n" +
					"Migrate it? -> SKIPPED. The user declined to decide. Leave this alone and report it; do not choose for them.",
			),
		);
		expect(await bobStub.getCurrentQuestions()).toStrictEqual([]);
		expect(await questionOutcomes(bob.userId)).toStrictEqual(["nope", "skip", "yep"]);
	});

	it("records why a token was refused without varying the refusal it puts on the wire", async () => {
		const grant = await issueGrant("mcp-refusal-reason-alice@example.com");
		const claims = decodeJwt(grant.accessToken);
		const nowSeconds = Math.floor(Date.now() / 1_000);
		const [expired, wrongAudience] = await Promise.all([
			signClaims({...claims, exp: nowSeconds - 1}),
			signClaims({...claims, aud: `${API_ORIGIN}/another-resource`, exp: nowSeconds + 600}),
		]);
		const signatureStart = grant.accessToken.lastIndexOf(".") + 1;
		const signature = grant.accessToken.slice(signatureStart);
		const forgedSignature = `${grant.accessToken.slice(0, signatureStart)}${
			signature.startsWith("A") ? "B" : "A"
		}${signature.slice(1)}`;

		const observations: string[] = [];
		vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
			observations.push(String(line));
		});
		let read = 0;
		async function refuse(token: string): Promise<Record<string, unknown>> {
			const response = await worker.fetch(mcpRequest(token, "tools/list"));
			const recorded = observations
				.slice(read)
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.filter((observation) => observation["event"] === "access_token_rejected");
			read = observations.length;
			return {
				body: await response.json(),
				challenge: response.headers.get("WWW-Authenticate"),
				recorded,
				status: response.status,
			};
		}
		const expiredRefusal = await refuse(expired);
		const audienceRefusal = await refuse(wrongAudience);
		const forgedRefusal = await refuse(forgedSignature);
		const unparsableRefusal = await refuse("not-a-json-web-token");

		const challenge =
			`Bearer resource_metadata="${API_ORIGIN}/.well-known/oauth-protected-resource/mcp", ` +
			`scope="${OAUTH_SCOPES.join(" ")}"`;
		const wireRefusal = {
			body: {error: {code: -32_000, message: "Invalid or missing access token"}, id: null, jsonrpc: "2.0"},
			challenge,
			status: 401,
		};
		function observation(reason: string): Record<string, unknown> {
			return {event: "access_token_rejected", failure: null, level: "warn", reason, status: null};
		}
		expect([expiredRefusal, audienceRefusal, forgedRefusal, unparsableRefusal]).toStrictEqual([
			{...wireRefusal, recorded: [observation("expired")]},
			{...wireRefusal, recorded: [observation("audience_mismatch")]},
			{...wireRefusal, recorded: [observation("signature_invalid")]},
			{...wireRefusal, recorded: [observation("malformed")]},
		]);
		expect(observations.join("").includes(grant.accessToken)).toBe(false);
	});

	it("rejects revoked, expired, wrong-audience, wrong-resource, and insufficient-scope credentials", async () => {
		const grant = await issueGrant("mcp-invalid-grant-alice@example.com");
		const claims = decodeJwt(grant.accessToken);
		const nowSeconds = Math.floor(Date.now() / 1_000);
		const [expired, wrongAudience, insufficientScope] = await Promise.all([
			signClaims({...claims, exp: nowSeconds - 1}),
			signClaims({...claims, aud: `${API_ORIGIN}/another-resource`, exp: nowSeconds + 600}),
			signClaims({...claims, scope: "openid offline_access", exp: nowSeconds + 600}),
		]);
		const rejected = await Promise.all(
			[expired, wrongAudience, insufficientScope].map(async (token) => {
				const response = await worker.fetch(mcpRequest(token, "tools/list"));
				return {body: await response.json(), status: response.status};
			}),
		);
		expect(rejected).toStrictEqual([
			{
				body: {error: {code: -32_000, message: "Invalid or missing access token"}, id: null, jsonrpc: "2.0"},
				status: 401,
			},
			{
				body: {error: {code: -32_000, message: "Invalid or missing access token"}, id: null, jsonrpc: "2.0"},
				status: 401,
			},
			{
				body: {
					error: {code: -32_000, message: "Access token has insufficient scope"},
					id: null,
					jsonrpc: "2.0",
				},
				status: 403,
			},
		]);
		const wrongSubject = await signClaims({...claims, sub: "mcp-cross-account-target"});
		const crossAccount = await worker.fetch(mcpRequest(wrongSubject, "tools/list"));
		expect({body: await crossAccount.json(), status: crossAccount.status}).toStrictEqual({
			body: {error: {code: -32_000, message: "Invalid or revoked access token"}, id: null, jsonrpc: "2.0"},
			status: 401,
		});
		expect(await env.USER_DO.getByName("mcp-cross-account-target").getCurrentQuestions()).toStrictEqual([]);

		await env.DB.prepare("UPDATE oauth_refresh_token SET resources = ? WHERE user_id = ?")
			.bind(JSON.stringify([`${API_ORIGIN}/wrong-resource`]), grant.userId)
			.run();
		const wrongResource = await worker.fetch(mcpRequest(grant.accessToken, "tools/list"));
		expect({body: await wrongResource.json(), status: wrongResource.status}).toStrictEqual({
			body: {error: {code: -32_000, message: "Invalid or revoked access token"}, id: null, jsonrpc: "2.0"},
			status: 401,
		});

		await env.DB.prepare("UPDATE oauth_refresh_token SET resources = ? WHERE user_id = ?")
			.bind(JSON.stringify([RESOURCE]), grant.userId)
			.run();
		const revocation = await worker.fetch(`${ISSUER}/oauth2/revoke`, {
			method: "POST",
			headers: {"Content-Type": "application/x-www-form-urlencoded"},
			body: new URLSearchParams({
				client_id: grant.clientId,
				token: grant.refreshToken,
				token_type_hint: "refresh_token",
			}),
		});
		expect({body: await revocation.text(), status: revocation.status}).toStrictEqual({body: "", status: 200});
		const revoked = await worker.fetch(mcpRequest(grant.accessToken, "tools/list"));
		expect({body: await revoked.json(), status: revoked.status}).toStrictEqual({
			body: {error: {code: -32_000, message: "Invalid or revoked access token"}, id: null, jsonrpc: "2.0"},
			status: 401,
		});
		expect(await env.USER_DO.getByName(grant.userId).getCurrentQuestions()).toStrictEqual([]);
	});

	it("reconnects the answer stream and still returns the browser answer", async () => {
		const grant = await issueGrant("mcp-reconnect-alice@example.com");
		const stub = env.USER_DO.getByName(grant.userId);
		await stub.setAfk(true, true);
		const responsePromise = remoteResponse(askRequest(grant.accessToken), TEST_TIMING);
		const questions = await waitForQuestionCount(grant.userId, 3);
		const batchId = required(questions[0], "first question").batchId;
		await closeAnswerSocket(stub, batchId);
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 30);
		});
		await stub.submitAnswers(
			questions.map((question) => ({question_id: question.questionId, disposition: "yep" as const})),
		);
		expect(await responseMessage(await responsePromise)).toStrictEqual(
			strictTextResponse("Ship it? -> YEP\nDelete it? -> YEP\nMigrate it? -> YEP"),
		);
	});

	it("retracts outstanding questions on cancellation and timeout", async () => {
		const cancelledGrant = await issueGrant("mcp-cancelled-alice@example.com");
		const cancelledStub = env.USER_DO.getByName(cancelledGrant.userId);
		await cancelledStub.setAfk(true, true);
		const controller = new AbortController();
		const cancelledResponse = await remoteResponse(askRequest(cancelledGrant.accessToken, controller.signal));
		await waitForQuestionCount(cancelledGrant.userId, 3);
		controller.abort();
		await cancelledResponse.text().catch(() => "cancelled");
		await waitForQuestionCount(cancelledGrant.userId, 0);
		expect(await questionOutcomes(cancelledGrant.userId)).toStrictEqual(["retracted", "retracted", "retracted"]);

		const timedOutGrant = await issueGrant("mcp-timeout-alice@example.com");
		const timedOutStub = env.USER_DO.getByName(timedOutGrant.userId);
		await timedOutStub.setAfk(true, true);
		const timeoutTiming = {...TEST_TIMING, answerTimeoutMilliseconds: 40};
		const timedOut = await remoteResponse(askRequest(timedOutGrant.accessToken), timeoutTiming);
		expect(await responseMessage(timedOut)).toStrictEqual(
			strictTextResponse("The ask_yep_nope call timed out before every question was answered.", true),
		);
		expect(await timedOutStub.getCurrentQuestions()).toStrictEqual([]);
		expect(await questionOutcomes(timedOutGrant.userId)).toStrictEqual(["retracted", "retracted", "retracted"]);
	});
});
