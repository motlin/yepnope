import {createExecutionContext, runInDurableObject} from "cloudflare:test";
import {env} from "cloudflare:workers";
import {decodeJwt} from "jose";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createWorkerAuthentication, MCP_RESOURCE_PATH, OAUTH_SCOPES} from "../auth";
import {handleRemoteMcpRequest, type RemoteMcpTiming} from "../mcp";
import type {CurrentQuestion, UserDurableObject} from "../user-do";
import {
	NATIVE_QUESTION_FALLBACK,
	NATIVE_QUESTION_FALLBACK_TEXT,
	TOOL_DESCRIPTION,
	TOOL_INPUT_SCHEMA,
} from "../../shim/tool";
import {API_ORIGIN, createVerifiedBrowserSession, required, worker} from "./helpers";

const ISSUER = `${API_ORIGIN}/api/auth`;
const RESOURCE = `${API_ORIGIN}${MCP_RESOURCE_PATH}`;
const REDIRECT_URI = "http://127.0.0.1:45678/callback/mcp-endpoint-test";
const CODE_VERIFIER = "mcp-endpoint-verifier-000000000000000000000000000000000000000000";
const TEST_TIMING: RemoteMcpTiming = {
	answerTimeoutMilliseconds: 500,
	heartbeatMilliseconds: 20,
	maximumConsecutiveFailures: 3,
	maximumReconnectDelayMilliseconds: 20,
	progressMilliseconds: 20,
	reconnectDelayMilliseconds: 5,
};

interface OAuthTokenResponse {
	access_token: string;
	refresh_token: string;
}

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

async function codeChallenge(): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(CODE_VERIFIER));
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

async function redirectUrl(response: Response): Promise<string> {
	const location = response.headers.get("location");
	if (location !== null) {
		return location;
	}
	const body: unknown = await response.json();
	if (typeof body !== "object" || body === null || !("url" in body) || typeof body.url !== "string") {
		throw new Error("OAuth response returned no redirect URL");
	}
	return body.url;
}

async function issueGrant(email: string, scopes: readonly string[] = OAUTH_SCOPES): Promise<IssuedGrant> {
	const {cookie, userId} = await createVerifiedBrowserSession(email);
	const registration = await worker.fetch(`${ISSUER}/oauth2/register`, {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify({
			application_type: "native",
			client_name: "MCP endpoint test client",
			grant_types: ["authorization_code", "refresh_token"],
			redirect_uris: [REDIRECT_URI],
			response_types: ["code"],
			scope: scopes.join(" "),
			token_endpoint_auth_method: "none",
		}),
	});
	const registered: unknown = await registration.json();
	if (
		typeof registered !== "object" ||
		registered === null ||
		!("client_id" in registered) ||
		typeof registered.client_id !== "string"
	) {
		throw new Error("OAuth registration returned no client id");
	}
	const clientId = registered.client_id;
	const authorizationQuery = new URLSearchParams({
		client_id: clientId,
		code_challenge: await codeChallenge(),
		code_challenge_method: "S256",
		prompt: "consent",
		redirect_uri: REDIRECT_URI,
		resource: RESOURCE,
		response_type: "code",
		scope: scopes.join(" "),
		state: "mcp-endpoint-state-00000000",
	});
	const authorization = await worker.fetch(`${ISSUER}/oauth2/authorize?${authorizationQuery}`, {
		headers: {Accept: "text/html", Cookie: cookie},
		redirect: "manual",
	});
	const consentUrl = new URL(await redirectUrl(authorization), API_ORIGIN);
	const consent = await worker.fetch(`${ISSUER}/oauth2/consent`, {
		method: "POST",
		headers: {"Content-Type": "application/json", Cookie: cookie, Origin: API_ORIGIN},
		body: JSON.stringify({accept: true, oauth_query: consentUrl.searchParams.toString()}),
		redirect: "manual",
	});
	const callback = new URL(await redirectUrl(consent));
	const code = callback.searchParams.get("code");
	if (code === null) {
		throw new Error("OAuth consent returned no authorization code");
	}
	const tokenResponse = await worker.fetch(`${ISSUER}/oauth2/token`, {
		method: "POST",
		headers: {"Content-Type": "application/x-www-form-urlencoded"},
		body: new URLSearchParams({
			client_id: clientId,
			code,
			code_verifier: CODE_VERIFIER,
			grant_type: "authorization_code",
			redirect_uri: REDIRECT_URI,
			resource: RESOURCE,
		}),
	});
	if (!tokenResponse.ok) {
		throw new Error(`OAuth token exchange failed with status ${String(tokenResponse.status)}`);
	}
	const tokens = await tokenResponse.json<OAuthTokenResponse>();
	return {accessToken: tokens.access_token, clientId, refreshToken: tokens.refresh_token, userId};
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
	const authentication = createWorkerAuthentication(env, createExecutionContext());
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
			questions.map(({body, branch, directory, position, project, repo, title, worktree}) => ({
				body,
				branch,
				directory,
				position,
				project,
				repo,
				title,
				worktree,
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
				worktree: null,
			},
			{
				body: "The legacy path is still in use.",
				branch: null,
				directory: null,
				position: 1,
				project: "Example project",
				repo: null,
				title: "Delete it?",
				worktree: null,
			},
			{
				body: "The optional migration can wait.",
				branch: null,
				directory: null,
				position: 2,
				project: "Example project",
				repo: null,
				title: "Migrate it?",
				worktree: null,
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
		expect(await bobStub.getActivitySummary()).toStrictEqual({
			expired: 0,
			nope: 1,
			outstanding: 0,
			retracted: 0,
			skip: 1,
			total_questions: 3,
			yep: 1,
		});
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
		expect(await cancelledStub.getActivitySummary()).toStrictEqual({
			expired: 0,
			nope: 0,
			outstanding: 0,
			retracted: 3,
			skip: 0,
			total_questions: 3,
			yep: 0,
		});

		const timedOutGrant = await issueGrant("mcp-timeout-alice@example.com");
		const timedOutStub = env.USER_DO.getByName(timedOutGrant.userId);
		await timedOutStub.setAfk(true, true);
		const timeoutTiming = {...TEST_TIMING, answerTimeoutMilliseconds: 40};
		const timedOut = await remoteResponse(askRequest(timedOutGrant.accessToken), timeoutTiming);
		expect(await responseMessage(timedOut)).toStrictEqual(
			strictTextResponse("The ask_yep_nope call timed out before every question was answered.", true),
		);
		expect(await timedOutStub.getCurrentQuestions()).toStrictEqual([]);
		expect(await timedOutStub.getActivitySummary()).toStrictEqual({
			expired: 0,
			nope: 0,
			outstanding: 0,
			retracted: 3,
			skip: 0,
			total_questions: 3,
			yep: 0,
		});
	});
});
