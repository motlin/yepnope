import {
	authenticateBrowserAccount,
	authenticateBrowserSession,
	authenticationMethods,
	hashToken,
	withRequestBackgroundTasks,
	workerAuthenticationFor,
} from "./auth";
import {
	getConnectedMcpClientAuthorizationState,
	listConnectedMcpClients,
	revokeConnectedMcpClient,
} from "./connected-mcp-clients";
import {
	decideDeviceAuthorization,
	lookupDeviceAuthorization,
	type DeviceAuthorizationLookup,
	type DeviceAuthorizationResult,
} from "./device-authorization";
import {handleHookEvent, MAX_HOOK_REQUEST_BYTES} from "./hook-bridge";
import {cleanupExpiredIdentityRecords} from "./identity-lifecycle";
import {handleRemoteMcpRequest} from "./mcp";
import {authenticateRequest, mcpResource} from "./oauth-token";
import {turnstileSiteKey} from "./turnstile";
import type {UserDurableObject} from "./user-do";
import {
	afkRequestSchema,
	createBatchRequestSchema,
	deviceAuthorizationRequestSchema,
	deviceLabelRequestSchema,
	MAX_REQUEST_BYTES,
	pushSubscriptionSchema,
	submitAnswersRequestSchema,
} from "./validation";
import {parseVapidJwk, vapidPublicKeyFromJwk} from "./webpush";

export {UserDurableObject} from "./user-do";

const STREAM_PATH = /^\/api\/v1\/questions\/[^/]+\/stream$/;
const CURRENT_DECK_STREAM_PATH = "/api/v1/current-deck/stream";
const CONNECTED_MCP_CLIENT_MANAGEMENT_PATH = /^\/api\/v1\/account\/connected-mcp-clients\/([0-9a-f]{64})$/;
const PUSH_DEVICE_MANAGEMENT_PATH = /^\/api\/v1\/account\/push-devices\/([0-9a-f]{64})$/;
const ROOT_AUTHENTICATION_METADATA_PATHS = new Set([
	"/.well-known/oauth-authorization-server/api/auth",
	"/.well-known/oauth-protected-resource",
	"/.well-known/oauth-protected-resource/mcp",
]);
export default {
	async fetch(request, environment, executionContext): Promise<Response> {
		const url = new URL(request.url);
		// 🛡️ Rude by design: reject on Content-Length before reading the body (spec §7.2).
		// The hook route carries whole tool_inputs and gets a higher ceiling (spec §10).
		const byteCeiling = url.pathname === "/api/v1/hook" ? MAX_HOOK_REQUEST_BYTES : MAX_REQUEST_BYTES;
		const contentLength = Number(request.headers.get("Content-Length") ?? "0");
		if (contentLength > byteCeiling) {
			return new Response(null, {status: 413});
		}

		const env = environment;
		if (url.pathname === "/mcp") {
			return handleRemoteMcpRequest(request, environment, executionContext);
		}
		if (
			url.pathname === "/api/auth" ||
			url.pathname.startsWith("/api/auth/") ||
			ROOT_AUTHENTICATION_METADATA_PATHS.has(url.pathname)
		) {
			return withRequestBackgroundTasks(executionContext, async () =>
				(await workerAuthenticationFor(env, url.pathname)).handler(request),
			);
		}

		// 🚪 The sign-in screen renders from this before anyone has a session, so it stays public.
		if (url.pathname === "/api/v1/auth-methods" && request.method === "GET") {
			const methods = authenticationMethods(env);
			return Response.json(
				{
					email_password: methods.emailPassword,
					magic_link: methods.magicLink,
					passkey: methods.passkey,
					social: methods.social,
					// 🤖 Public by construction, and the browser needs it before it can draw the
					// human-verification widget the Worker is about to demand. Null means this
					// deployment demands nothing.
					turnstile_site_key: turnstileSiteKey(env),
				},
				// Deploy-constant and identical for every visitor, so it is safe to cache publicly.
				{headers: {"Cache-Control": "public, max-age=300"}},
			);
		}
		if (url.pathname === "/api/v1/push/public-key" && request.method === "GET") {
			return Response.json({public_key: vapidPublicKeyFromJwk(parseVapidJwk(env.VAPID_PRIVATE_JWK))});
		}
		// 📟 The browser half of the device grant. It is the only place a code printed by a local
		// command becomes an authorization, so it demands the account's own session, never a token.
		if (
			url.pathname === "/api/v1/device-authorization" &&
			(request.method === "GET" || request.method === "POST")
		) {
			const accountUserId = await authenticateBrowserSession(request, env, executionContext);
			if (accountUserId === null) {
				return new Response(null, {status: 401});
			}
			return request.method === "GET"
				? describeDeviceAuthorization(url, env, accountUserId)
				: decideBrowserDeviceAuthorization(request, env, accountUserId);
		}
		const connectedMcpClientManagementMatch = CONNECTED_MCP_CLIENT_MANAGEMENT_PATH.exec(url.pathname);
		const pushDeviceManagementMatch = PUSH_DEVICE_MANAGEMENT_PATH.exec(url.pathname);
		if (
			(url.pathname === "/api/v1/account/devices" && request.method === "GET") ||
			(connectedMcpClientManagementMatch !== null && request.method === "DELETE") ||
			(pushDeviceManagementMatch !== null && (request.method === "PUT" || request.method === "DELETE"))
		) {
			const browserAccount = await authenticateBrowserAccount(request, env, executionContext);
			if (browserAccount === null) {
				return new Response(null, {status: 401});
			}
			const accountUserId = browserAccount.userId;
			const accountStub = env.USER_DO.getByName(accountUserId);
			if (url.pathname === "/api/v1/account/devices") {
				return listAccountDevices(
					env.DB,
					accountStub,
					accountUserId,
					browserAccount.sessionId,
					mcpResource(env),
				);
			}
			if (connectedMcpClientManagementMatch !== null) {
				return manageConnectedMcpClient(env, accountUserId, connectedMcpClientManagementMatch[1]);
			}
			return managePushDevice(request, accountStub, pushDeviceManagementMatch?.[1]);
		}

		const userId = await authenticateRequest(request, env, executionContext);
		if (userId === null) {
			return new Response(null, {status: 401});
		}
		const stub = env.USER_DO.getByName(userId);

		if (url.pathname === "/api/v1/push/subscribe" && request.method === "POST") {
			return subscribePush(request, stub);
		}
		if (request.method === "GET" && (url.pathname === CURRENT_DECK_STREAM_PATH || STREAM_PATH.test(url.pathname))) {
			if (url.pathname === CURRENT_DECK_STREAM_PATH) {
				const authorizationState = await connectedMcpClientAuthorizationState(env, userId);
				return stub.fetch(withConnectedMcpClientAuthorizationState(request, authorizationState));
			}
			return stub.fetch(request);
		}
		if (url.pathname === "/api/v1/hook" && request.method === "POST") {
			const authorizationState = await connectedMcpClientAuthorizationState(env, userId);
			return handleHookEvent(request, stub, authorizationState.activeClientCount > 0, executionContext);
		}
		if (url.pathname === "/api/v1/afk" && request.method === "GET") {
			const authorizationState = await connectedMcpClientAuthorizationState(env, userId);
			return Response.json({afk: await stub.getAfk(authorizationState.activeClientCount > 0)});
		}
		if (url.pathname === "/api/v1/afk" && request.method === "PUT") {
			const authorizationState = await connectedMcpClientAuthorizationState(env, userId);
			return setAfk(request, stub, authorizationState.activeClientCount > 0);
		}
		if (url.pathname === "/api/v1/questions" && request.method === "POST") {
			const authorizationState = await connectedMcpClientAuthorizationState(env, userId);
			return createQuestions(request, stub, authorizationState.activeClientCount > 0, executionContext);
		}
		if (url.pathname === "/api/v1/current-deck" && request.method === "GET") {
			return currentDeck(stub);
		}
		if (url.pathname === "/api/v1/activity-summary" && request.method === "GET") {
			return Response.json({activity_summary: await stub.getActivitySummary()});
		}
		if (url.pathname === "/api/v1/answers" && request.method === "POST") {
			return submitAnswers(request, stub);
		}
		return new Response(null, {status: 404});
	},
	scheduled(controller, environment, executionContext): void {
		executionContext.waitUntil(runScheduledCleanup(environment, controller.scheduledTime));
	},
} satisfies ExportedHandler<Env>;

/**
 * 🔭 The nightly sweep leaves exactly one line behind, and that line is counts. No client id,
 * redirect URI, secret, or user identifier is ever in a position to reach it.
 */
async function runScheduledCleanup(environment: Env, scheduledTime: number): Promise<void> {
	const cleanup = await cleanupExpiredIdentityRecords(environment.DB, environment.USER_DO, scheduledTime);
	console.warn(JSON.stringify({event: "scheduled_cleanup_completed", ...cleanup}));
}

type UnavailableDeviceAuthorization = Exclude<
	(DeviceAuthorizationLookup | DeviceAuthorizationResult)["status"],
	"pending"
>;

// 📟 Gone, spent, and already answered are three different things to the command that is polling.
const DEVICE_AUTHORIZATION_STATUS_CODES: Readonly<Record<UnavailableDeviceAuthorization, number>> = {
	decided: 409,
	expired: 410,
	not_found: 404,
	taken: 409,
};

async function describeDeviceAuthorization(url: URL, environment: Env, userId: string): Promise<Response> {
	const userCode = url.searchParams.get("user_code");
	if (userCode === null) {
		return new Response(null, {status: 400});
	}
	const lookup = await lookupDeviceAuthorization(
		environment.DB,
		userId,
		userCode,
		mcpResource(environment),
		Date.now(),
	);
	if (lookup.status !== "pending") {
		return Response.json({status: lookup.status}, {status: DEVICE_AUTHORIZATION_STATUS_CODES[lookup.status]});
	}
	return Response.json({
		client_name: lookup.authorization.clientName,
		scopes: lookup.authorization.scopes,
		status: "pending",
		user_code: lookup.authorization.userCode,
	});
}

async function decideBrowserDeviceAuthorization(request: Request, environment: Env, userId: string): Promise<Response> {
	const url = new URL(request.url);
	const decision = url.searchParams.get("decision");
	if (decision !== "approved" && decision !== "denied") {
		return new Response(null, {status: 400});
	}
	const parsed = deviceAuthorizationRequestSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return new Response(null, {status: 400});
	}
	const result = await decideDeviceAuthorization(
		environment.DB,
		userId,
		parsed.data.user_code,
		decision,
		mcpResource(environment),
		Date.now(),
	);
	if (result.status !== "decided" || result.decision !== decision) {
		return Response.json({status: result.status}, {status: DEVICE_AUTHORIZATION_STATUS_CODES[result.status]});
	}
	return Response.json({status: "decided", decision});
}

async function connectedMcpClientAuthorizationState(
	environment: Env,
	userId: string,
): Promise<{activeClientCount: number}> {
	return getConnectedMcpClientAuthorizationState(environment.DB, userId, mcpResource(environment));
}

function withConnectedMcpClientAuthorizationState(
	request: Request,
	authorizationState: {activeClientCount: number},
): Request {
	const headers = new Headers(request.headers);
	headers.set("X-YepNope-Connected-Mcp-Client-Authorization", JSON.stringify(authorizationState));
	return new Request(request, {headers});
}

// 🧍 An active OAuth grant — browser-authorized MCP client or device-authorized hook — gates AFK.
async function setAfk(
	request: Request,
	stub: DurableObjectStub<UserDurableObject>,
	hasActiveConnectedMcpClient: boolean,
): Promise<Response> {
	const parsed = afkRequestSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return new Response(null, {status: 400});
	}
	const result = await stub.setAfk(parsed.data.afk, hasActiveConnectedMcpClient);
	if (result.status === "connected_mcp_client_required") {
		return Response.json({error: result.status, message: result.message}, {status: 409});
	}
	return Response.json({afk: result.afk});
}

async function subscribePush(request: Request, stub: DurableObjectStub<UserDurableObject>): Promise<Response> {
	const parsed = pushSubscriptionSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return new Response(null, {status: 400});
	}
	await stub.registerDevice(parsed.data, "Browser notifications");
	return Response.json({status: "ok"});
}

interface BrowserSessionRow {
	id: string;
	created_at: number;
	updated_at: number;
	expires_at: number;
	user_agent: string | null;
}

function browserSessionDisplayName(userAgent: string | null): string {
	if (userAgent === null) {
		return "Browser session";
	}
	const browser = userAgent.includes("Edg/")
		? "Edge"
		: userAgent.includes("Firefox/")
			? "Firefox"
			: userAgent.includes("Chrome/") || userAgent.includes("CriOS/")
				? "Chrome"
				: userAgent.includes("Safari/")
					? "Safari"
					: "Browser";
	const platform = /iPhone|iPod/.test(userAgent)
		? "iPhone"
		: userAgent.includes("iPad")
			? "iPad"
			: userAgent.includes("Android")
				? "Android"
				: /Macintosh|Mac OS X/.test(userAgent)
					? "macOS"
					: userAgent.includes("Windows")
						? "Windows"
						: userAgent.includes("Linux")
							? "Linux"
							: "unknown platform";
	return `${browser} on ${platform}`;
}

async function listBrowserSessions(
	database: D1Database,
	userId: string,
	currentSessionId: string,
): Promise<
	Array<{
		id: string;
		display_name: string;
		created_at: number;
		last_active_at: number;
		expires_at: number;
		current: boolean;
	}>
> {
	const sessions = await database
		.prepare(
			"SELECT id, created_at, updated_at, expires_at, user_agent FROM session " +
				"WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC, id",
		)
		.bind(userId, Date.now())
		.all<BrowserSessionRow>();
	return Promise.all(
		sessions.results.map(async (session) => ({
			id: await hashToken(`browser-session\0${userId}\0${session.id}`),
			display_name: browserSessionDisplayName(session.user_agent),
			created_at: session.created_at,
			last_active_at: session.updated_at,
			expires_at: session.expires_at,
			current: session.id === currentSessionId,
		})),
	);
}

async function listAccountDevices(
	database: D1Database,
	stub: DurableObjectStub<UserDurableObject>,
	userId: string,
	currentSessionId: string,
	resource: string,
): Promise<Response> {
	const [browserSessions, connectedMcpClients, pushDevices] = await Promise.all([
		listBrowserSessions(database, userId, currentSessionId),
		listConnectedMcpClients(database, userId, resource),
		stub.listPushDevices(),
	]);
	return Response.json({
		browser_sessions: browserSessions,
		connected_mcp_clients: connectedMcpClients.map((client) => ({
			id: client.id,
			display_name: client.displayName,
			authorized_at: client.authorizedAt,
			last_used_at: client.lastUsedAt,
			granted_scopes: client.grantedScopes,
			status: client.status,
			revoked_at: client.revokedAt,
		})),
		push_devices: pushDevices.map((device) => ({
			id: device.id,
			label: device.label,
			created_at: device.createdAt,
		})),
	});
}

async function manageConnectedMcpClient(
	environment: Env,
	userId: string,
	connectedMcpClientId: string | undefined,
): Promise<Response> {
	if (connectedMcpClientId === undefined) {
		return new Response(null, {status: 404});
	}
	const revoked = await revokeConnectedMcpClient(
		environment.DB,
		environment.USER_DO,
		userId,
		mcpResource(environment),
		connectedMcpClientId,
		Date.now(),
	);
	if (!revoked) {
		return new Response(null, {status: 404});
	}
	const authorizationState = await connectedMcpClientAuthorizationState(environment, userId);
	return Response.json({status: "ok", connected_mcp_client_count: authorizationState.activeClientCount});
}

async function managePushDevice(
	request: Request,
	stub: DurableObjectStub<UserDurableObject>,
	deviceId: string | undefined,
): Promise<Response> {
	if (deviceId === undefined) {
		return new Response(null, {status: 404});
	}
	if (request.method === "PUT") {
		const parsed = deviceLabelRequestSchema.safeParse(await request.json().catch(() => null));
		if (!parsed.success) {
			return new Response(null, {status: 400});
		}
		return (await stub.renamePushDevice(deviceId, parsed.data.label))
			? Response.json({status: "ok"})
			: new Response(null, {status: 404});
	}
	return (await stub.revokePushDevice(deviceId)) ? Response.json({status: "ok"}) : new Response(null, {status: 404});
}

async function createQuestions(
	request: Request,
	stub: DurableObjectStub<UserDurableObject>,
	hasActiveConnectedMcpClient: boolean,
	executionContext: ExecutionContext,
): Promise<Response> {
	const parsed = createBatchRequestSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return new Response(null, {status: 400});
	}
	// 🧍 Interception point 3 (spec §11.3): with AFK off, ask_yep_nope gets a teaching error instead of a batch.
	if (!(await stub.getAfk(hasActiveConnectedMcpClient))) {
		return Response.json(
			{
				error: "afk_off",
				message:
					"The user is at their keyboard, so questions are not being routed to their phone. " +
					"Use the AskUserQuestion tool instead of ask_yep_nope for this question.",
			},
			{status: 409},
		);
	}
	const created = await stub.createBatch(parsed.data);
	// 📣 One push per batch, sent outside the response path (spec §6.1/§6.2).
	executionContext.waitUntil(stub.sendBatchPush(created.batchId));
	return Response.json({batch_id: created.batchId, question_ids: created.questionIds}, {status: 201});
}

async function currentDeck(stub: DurableObjectStub<UserDurableObject>): Promise<Response> {
	const state = await stub.getCurrentDeckState({activeClientCount: 0});
	return Response.json({current_deck: state.current_deck});
}

async function submitAnswers(request: Request, stub: DurableObjectStub<UserDurableObject>): Promise<Response> {
	const parsed = submitAnswersRequestSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return new Response(null, {status: 400});
	}
	try {
		await stub.submitAnswers(parsed.data.answers);
	} catch (error) {
		if (error instanceof Error) {
			if (error.message.startsWith("unknown_question")) {
				return new Response(null, {status: 404});
			}
			if (error.message.startsWith("already_answered")) {
				return new Response(null, {status: 409});
			}
			if (error.message.startsWith("duplicate_question")) {
				return new Response(null, {status: 400});
			}
		}
		throw error;
	}
	return Response.json({status: "ok"});
}
