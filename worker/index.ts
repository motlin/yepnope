import {
	authenticateBrowserAccount,
	authenticateBrowserSession,
	authenticateRequest,
	createWorkerAuthentication,
	hashToken,
	MCP_RESOURCE_PATH,
} from "./auth";
import {
	getConnectedMcpClientAuthorizationState,
	listConnectedMcpClients,
	revokeConnectedMcpClient,
} from "./connected-mcp-clients";
import {handleHookEvent, MAX_HOOK_REQUEST_BYTES} from "./hook-bridge";
import {claimLegacyIdentity} from "./identity-linking";
import {cleanupExpiredIdentityRecords} from "./identity-lifecycle";
import {handleRemoteMcpRequest} from "./mcp";
import {
	claimPairingCode,
	createPairingCode,
	getPairingStatus,
	renameMachine,
	revokeMachineToken,
	type PairingStatus,
} from "./pairing";
import type {UserDurableObject} from "./user-do";
import {
	afkRequestSchema,
	createBatchRequestSchema,
	deviceLabelRequestSchema,
	legacyIdentityClaimRequestSchema,
	MAX_REQUEST_BYTES,
	pairClaimRequestSchema,
	pushSubscriptionSchema,
	submitAnswersRequestSchema,
} from "./validation";
import {parseVapidJwk, vapidPublicKeyFromJwk} from "./webpush";

export {UserDurableObject} from "./user-do";

const STREAM_PATH = /^\/api\/v1\/questions\/[^/]+\/stream$/;
const CURRENT_DECK_STREAM_PATH = "/api/v1/current-deck/stream";
const MACHINE_MANAGEMENT_PATH = /^\/api\/v1\/account\/machines\/([0-9a-f]{32})$/;
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
			return createWorkerAuthentication(env, executionContext).handler(request);
		}

		// 🤝 Machine claims and the VAPID key are the only unauthenticated application routes.
		if (url.pathname === "/api/v1/pair/claim" && request.method === "POST") {
			return claimPairing(request, env);
		}
		if (url.pathname === "/api/v1/push/public-key" && request.method === "GET") {
			return Response.json({public_key: vapidPublicKeyFromJwk(parseVapidJwk(env.VAPID_PRIVATE_JWK))});
		}
		if (url.pathname === "/api/v1/pair/code" && request.method === "POST") {
			const accountUserId = await authenticateBrowserSession(request, env, executionContext);
			if (accountUserId === null) {
				return new Response(null, {status: 401});
			}
			const issued = await createPairingCode(env.DB, accountUserId);
			const pairingStatus = await getPairingStatus(env.DB, accountUserId);
			return Response.json(
				{code: issued.code, expires_at: issued.expiresAt, pairing: pairingStatusResponse(pairingStatus)},
				{status: 201},
			);
		}
		if (url.pathname === "/api/v1/pair/new" && request.method === "POST") {
			const accountUserId = await authenticateBrowserSession(request, env, executionContext);
			return accountUserId === null ? new Response(null, {status: 401}) : Response.json({status: "ready"});
		}
		if (url.pathname === "/api/v1/pair/status" && request.method === "GET") {
			const accountUserId = await authenticateBrowserSession(request, env, executionContext);
			if (accountUserId === null) {
				return new Response(null, {status: 401});
			}
			const pairingStatus = await getPairingStatus(env.DB, accountUserId);
			return Response.json(pairingStatusResponse(pairingStatus));
		}
		if (url.pathname === "/api/v1/account/claim-legacy" && request.method === "POST") {
			const accountUserId = await authenticateBrowserSession(request, env, executionContext);
			if (accountUserId === null) {
				return new Response(null, {status: 401});
			}
			return claimLegacyBrowserIdentity(request, env, accountUserId);
		}
		const machineManagementMatch = MACHINE_MANAGEMENT_PATH.exec(url.pathname);
		const connectedMcpClientManagementMatch = CONNECTED_MCP_CLIENT_MANAGEMENT_PATH.exec(url.pathname);
		const pushDeviceManagementMatch = PUSH_DEVICE_MANAGEMENT_PATH.exec(url.pathname);
		if (
			(url.pathname === "/api/v1/account/devices" && request.method === "GET") ||
			(connectedMcpClientManagementMatch !== null && request.method === "DELETE") ||
			(machineManagementMatch !== null && (request.method === "PUT" || request.method === "DELETE")) ||
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
			if (machineManagementMatch !== null) {
				return manageMachine(request, env, accountUserId, machineManagementMatch[1]);
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
	scheduled(_controller, environment, executionContext): void {
		executionContext.waitUntil(cleanupExpiredIdentityRecords(environment.DB, environment.USER_DO, Date.now()));
	},
} satisfies ExportedHandler<Env>;

function pairingStatusResponse(pairingStatus: PairingStatus): {
	paired: boolean;
	machine_count: number;
	pending_pairing_expires_at: number | null;
} {
	return {
		paired: pairingStatus.machineCount > 0,
		machine_count: pairingStatus.machineCount,
		pending_pairing_expires_at: pairingStatus.pendingPairingExpiresAt,
	};
}

function mcpResource(environment: Env): string {
	return `${environment.BETTER_AUTH_URL}${MCP_RESOURCE_PATH}`;
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

// 🧍 An active OAuth MCP or CLI grant gates AFK; legacy machine pairing never authorizes routing.
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

async function claimPairing(request: Request, environment: Env): Promise<Response> {
	const parsed = pairClaimRequestSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return new Response(null, {status: 400});
	}
	const claimed = await claimPairingCode(environment.DB, parsed.data.code, parsed.data.label);
	if (claimed === null) {
		return new Response(null, {status: 404});
	}
	return Response.json({token: claimed.token, credential_type: "machine"}, {status: 201});
}

async function claimLegacyBrowserIdentity(request: Request, environment: Env, userId: string): Promise<Response> {
	const parsed = legacyIdentityClaimRequestSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return new Response(null, {status: 400});
	}
	const result = await claimLegacyIdentity(environment.DB, environment.USER_DO, userId, parsed.data.legacy_token);
	if (result.status === "not_found") {
		return new Response(null, {status: 404});
	}
	if (result.status === "conflict") {
		return Response.json({message: result.message}, {status: 409});
	}
	return Response.json({status: "claimed", already_claimed: result.alreadyClaimed});
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

async function manageMachine(
	request: Request,
	environment: Env,
	userId: string,
	machineId: string | undefined,
): Promise<Response> {
	if (machineId === undefined) {
		return new Response(null, {status: 404});
	}
	if (request.method === "PUT") {
		const parsed = deviceLabelRequestSchema.safeParse(await request.json().catch(() => null));
		if (!parsed.success) {
			return new Response(null, {status: 400});
		}
		return (await renameMachine(environment.DB, userId, machineId, parsed.data.label))
			? Response.json({status: "ok"})
			: new Response(null, {status: 404});
	}
	const revoked = await revokeMachineToken(environment.DB, userId, machineId, Date.now());
	if (!revoked) {
		return new Response(null, {status: 404});
	}
	const pairingStatus = await getPairingStatus(environment.DB, userId);
	return Response.json({status: "ok", pairing: pairingStatusResponse(pairingStatus)});
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
