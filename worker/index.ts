import {authenticateBrowserSession, authenticateRequest, createWorkerAuthentication} from "./auth";
import {handleHookEvent, MAX_HOOK_REQUEST_BYTES} from "./hook-bridge";
import {claimLegacyIdentity} from "./identity-linking";
import {cleanupExpiredIdentityRecords} from "./identity-lifecycle";
import {createObservationContext, emitObservation, observeEnvironment, observeHttpExchange} from "./observability";
import {
	claimPairingCode,
	createPairingCode,
	getPairedMachineCount,
	listPairedMachines,
	renameMachine,
	revokeMachineToken,
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
const PUSH_DEVICE_MANAGEMENT_PATH = /^\/api\/v1\/account\/push-devices\/([0-9a-f]{64})$/;

export default {
	async fetch(request, environment, executionContext): Promise<Response> {
		const observationContext = createObservationContext("worker.main");
		const env = observeEnvironment(environment, observationContext);
		return observeHttpExchange(observationContext, request, async () => {
			const url = new URL(request.url);
			// 🛡️ Rude by design: reject on Content-Length before reading the body (spec §7.2).
			// The hook route carries whole tool_inputs and gets a higher ceiling (spec §10).
			const byteCeiling = url.pathname === "/api/v1/hook" ? MAX_HOOK_REQUEST_BYTES : MAX_REQUEST_BYTES;
			const contentLength = Number(request.headers.get("Content-Length") ?? "0");
			if (contentLength > byteCeiling) {
				return new Response(null, {status: 413});
			}

			if (url.pathname === "/api/auth" || url.pathname.startsWith("/api/auth/")) {
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
				return Response.json({code: issued.code, expires_at: issued.expiresAt}, {status: 201});
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
				const machineCount = await getPairedMachineCount(env.DB, accountUserId);
				return Response.json({paired: machineCount > 0, machine_count: machineCount});
			}
			if (url.pathname === "/api/v1/account/claim-legacy" && request.method === "POST") {
				const accountUserId = await authenticateBrowserSession(request, env, executionContext);
				if (accountUserId === null) {
					return new Response(null, {status: 401});
				}
				return claimLegacyBrowserIdentity(request, env, accountUserId);
			}
			const machineManagementMatch = MACHINE_MANAGEMENT_PATH.exec(url.pathname);
			const pushDeviceManagementMatch = PUSH_DEVICE_MANAGEMENT_PATH.exec(url.pathname);
			if (
				(url.pathname === "/api/v1/account/devices" && request.method === "GET") ||
				(machineManagementMatch !== null && (request.method === "PUT" || request.method === "DELETE")) ||
				(pushDeviceManagementMatch !== null && (request.method === "PUT" || request.method === "DELETE"))
			) {
				const accountUserId = await authenticateBrowserSession(request, env, executionContext);
				if (accountUserId === null) {
					return new Response(null, {status: 401});
				}
				const accountStub = env.USER_DO.getByName(accountUserId);
				if (url.pathname === "/api/v1/account/devices") {
					return listAccountDevices(env.DB, accountStub, accountUserId);
				}
				if (machineManagementMatch !== null) {
					return manageMachine(request, env, accountUserId, machineManagementMatch[1]);
				}
				return managePushDevice(request, accountStub, pushDeviceManagementMatch?.[1]);
			}

			const authenticatedRequest = withBrowserSocketAuthorization(request, url);
			const userId = await authenticateRequest(authenticatedRequest, env, executionContext);
			if (userId === null) {
				return new Response(null, {status: 401});
			}
			const stub = env.USER_DO.getByName(userId);

			if (url.pathname === "/api/v1/push/subscribe" && request.method === "POST") {
				return subscribePush(request, stub);
			}
			if (
				request.method === "GET" &&
				(url.pathname === CURRENT_DECK_STREAM_PATH || STREAM_PATH.test(url.pathname))
			) {
				if (url.pathname === CURRENT_DECK_STREAM_PATH) {
					const machineCount = await getPairedMachineCount(env.DB, userId);
					return stub.fetch(withMachineCount(authenticatedRequest, machineCount));
				}
				return stub.fetch(authenticatedRequest);
			}
			if (url.pathname === "/api/v1/hook" && request.method === "POST") {
				const machineCount = await getPairedMachineCount(env.DB, userId);
				return handleHookEvent(request, stub, machineCount > 0, executionContext, observationContext);
			}
			if (url.pathname === "/api/v1/afk" && request.method === "GET") {
				const machineCount = await getPairedMachineCount(env.DB, userId);
				return Response.json({afk: await stub.getAfk(machineCount > 0)});
			}
			if (url.pathname === "/api/v1/afk" && request.method === "PUT") {
				const machineCount = await getPairedMachineCount(env.DB, userId);
				return setAfk(request, stub, machineCount > 0);
			}
			if (url.pathname === "/api/v1/questions" && request.method === "POST") {
				const machineCount = await getPairedMachineCount(env.DB, userId);
				return createQuestions(request, stub, machineCount > 0, executionContext);
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
		});
	},
	scheduled(controller, environment, executionContext): void {
		const observationContext = createObservationContext("worker.main.scheduled");
		const env = observeEnvironment(environment, observationContext);
		emitObservation(observationContext, "scheduled", "input", {
			cron: controller.cron,
			scheduledTime: controller.scheduledTime,
		});
		executionContext.waitUntil(
			cleanupExpiredIdentityRecords(env.DB, env.USER_DO, Date.now()).then(
				(result) => {
					emitObservation(observationContext, "scheduled", "output", result);
				},
				(error: unknown) => {
					emitObservation(observationContext, "scheduled", "failure", error, "error");
					throw error;
				},
			),
		);
	},
} satisfies ExportedHandler<Env>;

function withBrowserSocketAuthorization(request: Request, url: URL): Request {
	if (
		url.pathname !== CURRENT_DECK_STREAM_PATH ||
		request.headers.has("Authorization") ||
		request.headers.get("Upgrade") !== "websocket"
	) {
		return request;
	}
	const protocols = request.headers
		.get("Sec-WebSocket-Protocol")
		?.split(",")
		.map((protocol) => protocol.trim());
	if (protocols?.length !== 2 || protocols[0] !== "yepnope" || protocols[1] === undefined) {
		return request;
	}
	const headers = new Headers(request.headers);
	headers.set("Authorization", `Bearer ${protocols[1]}`);
	return new Request(request, {headers});
}

function withMachineCount(request: Request, machineCount: number): Request {
	const headers = new Headers(request.headers);
	headers.set("X-YepNope-Machine-Count", String(machineCount));
	return new Request(request, {headers});
}

// 🧍 Pairing gates the stored AFK preference, so an unpaired account can never route questions away.
async function setAfk(
	request: Request,
	stub: DurableObjectStub<UserDurableObject>,
	paired: boolean,
): Promise<Response> {
	const parsed = afkRequestSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return new Response(null, {status: 400});
	}
	const result = await stub.setAfk(parsed.data.afk, paired);
	if (result.status === "pairing_required") {
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
	const machineCount = await getPairedMachineCount(environment.DB, claimed.userId);
	await environment.USER_DO.getByName(claimed.userId).synchronizePairingState(machineCount);
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

async function listAccountDevices(
	database: D1Database,
	stub: DurableObjectStub<UserDurableObject>,
	userId: string,
): Promise<Response> {
	const [machines, pushDevices] = await Promise.all([listPairedMachines(database, userId), stub.listPushDevices()]);
	return Response.json({
		machines: machines.map((machine) => ({
			id: machine.id,
			label: machine.label,
			created_at: machine.createdAt,
			last_used_at: machine.lastUsedAt,
		})),
		push_devices: pushDevices.map((device) => ({
			id: device.id,
			label: device.label,
			created_at: device.createdAt,
		})),
	});
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
	const revoked = await revokeMachineToken(environment.DB, environment.USER_DO, userId, machineId, Date.now());
	if (!revoked) {
		return new Response(null, {status: 404});
	}
	const machineCount = await getPairedMachineCount(environment.DB, userId);
	return Response.json({status: "ok", pairing: {paired: machineCount > 0, machine_count: machineCount}});
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
	paired: boolean,
	executionContext: ExecutionContext,
): Promise<Response> {
	const parsed = createBatchRequestSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return new Response(null, {status: 400});
	}
	// 🧍 Interception point 3 (spec §11.3): with AFK off, ask_yep_nope gets a teaching error instead of a batch.
	if (!(await stub.getAfk(paired))) {
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
	const state = await stub.getCurrentDeckState(0);
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
