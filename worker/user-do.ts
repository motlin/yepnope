// fallow-ignore-file unused-class-member -- RPC methods are invoked through DurableObjectStub, which fallow cannot trace
import {DurableObject} from "cloudflare:workers";
import {and, asc, count, eq, inArray, isNull, lte, min, sql} from "drizzle-orm";
import {drizzle, type DrizzleSqliteDODatabase} from "drizzle-orm/durable-sqlite";
import {migrate} from "drizzle-orm/durable-sqlite/migrator";
import {z} from "zod";
import {
	answers,
	batches,
	devices,
	identityMergeLock,
	identityMerges,
	questionActivity,
	questions,
	state,
} from "./db/do-schema";
import migrationBundle from "./migrations/do/migrations.js";
import {hashToken} from "./auth";
import {
	createObservationContext,
	emitObservation,
	observeDurableObjectState,
	observeHttpExchange,
	observeWebSocketFrame,
	type ObservationContext,
} from "./observability";
import {errorFrame, isComplete, resolvedFrame, stateFrame, type DispositionMap} from "./protocol";
import {
	dispositionSchema,
	HEARTBEAT_GRACE_MILLISECONDS,
	pushSubscriptionSchema,
	RETENTION_MILLISECONDS,
	type CreateBatchRequest,
	type Disposition,
} from "./validation";
import {buildPushRequest, parseVapidJwk, type PushSubscription} from "./webpush";

export interface CreatedBatch {
	batchId: string;
	questionIds: string[];
}

export interface CurrentQuestion {
	batchId: string;
	project: string;
	repo: string | null;
	branch: string | null;
	worktree: string | null;
	directory: string | null;
	questionId: string;
	position: number;
	title: string;
	body: string;
	createdAt: number;
}

export interface CurrentQuestionPayload {
	batch_id: string;
	project: string;
	repo: string | null;
	branch: string | null;
	worktree: string | null;
	directory: string | null;
	question_id: string;
	position: number;
	title: string;
	body: string;
	created_at: number;
}

export interface CurrentDeckState {
	type: "current_deck";
	afk: boolean;
	connected_mcp_client_count: number;
	current_deck: CurrentQuestionPayload[];
}

interface ConnectedMcpClientAuthorizationState {
	activeClientCount: number;
}

export interface ActivitySummary {
	total_questions: number;
	outstanding: number;
	yep: number;
	nope: number;
	skip: number;
	retracted: number;
	expired: number;
}

export type AfkUpdateResult =
	| {status: "updated"; afk: boolean}
	| {status: "connected_mcp_client_required"; message: string};

export interface SubmittedAnswer {
	question_id: string;
	disposition: Disposition;
}

export interface PushDevice {
	id: string;
	label: string;
	createdAt: number;
}

export interface RedactedStorageDiagnostics {
	alarm_set: boolean;
	table_counts: Array<{name: string; rows: number}>;
}

export interface LegacyIdentitySnapshot {
	devices: Array<typeof devices.$inferSelect>;
	batches: Array<typeof batches.$inferSelect>;
	questions: Array<typeof questions.$inferSelect>;
	answers: Array<typeof answers.$inferSelect>;
	questionActivity: Array<typeof questionActivity.$inferSelect>;
}

export type LegacyIdentityPreparation =
	| {status: "ready"; snapshot: LegacyIdentitySnapshot}
	| {status: "conflict"; reason: string};

export type LegacyIdentityMergeResult =
	| {status: "merged"}
	| {status: "already_merged"}
	| {status: "conflict"; reason: string};

const STATE_ROW_ID = 1;
const CURRENT_DECK_SOCKET_TAG = "current-deck";
const MCP_REQUEST_STORAGE_PREFIX = "mcp-request:";

enum TerminalActivityOutcome {
	Retracted = "retracted",
	Expired = "expired",
}

interface CurrentDeckSocketAttachment {
	connectedMcpClientAuthorizationState: ConnectedMcpClientAuthorizationState;
}

const connectedMcpClientAuthorizationStateSchema = z.object({
	activeClientCount: z.number().int().nonnegative(),
});
const currentDeckSocketAttachmentSchema = z.object({
	connectedMcpClientAuthorizationState: connectedMcpClientAuthorizationStateSchema,
});

function findRowConflict<Row extends object>(
	existingRows: Row[],
	incomingRows: Row[],
	key: (row: Row) => string,
): string | null {
	const existingById = new Map(existingRows.map((row) => [key(row), row]));
	for (const incoming of incomingRows) {
		if (existingById.has(key(incoming))) {
			return `conflicting Durable Object row: ${key(incoming)}`;
		}
	}
	return null;
}

export class UserDurableObject extends DurableObject<Env> {
	private readonly database: DrizzleSqliteDODatabase;
	private readonly observationContext: ObservationContext;
	private initialization: Promise<void> | undefined;

	constructor(ctx: DurableObjectState<Record<never, never>>, env: Env) {
		super(ctx, env);
		this.observationContext = {
			...createObservationContext("durable_object.user"),
			objectId: ctx.id.toString(),
		};
		this.ctx = observeDurableObjectState(ctx, this.observationContext);
		this.database = drizzle(this.ctx.storage);
	}

	private async initialize(): Promise<void> {
		this.initialization ??= (async () => {
			const migration = migrationBundle.journal.entries[0];
			const migrationHash = migrationBundle.hashes["m0000"];
			if (
				migrationBundle.journal.entries.length !== 1 ||
				migration === undefined ||
				migrationHash === undefined
			) {
				throw new Error("Durable Object migration bundle must contain exactly one hashed baseline");
			}
			await migrate(this.database, migrationBundle);
			this.ctx.storage.sql.exec(
				"UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ? AND hash = ''",
				migrationHash,
				migration.when,
			);
			const migrationRecords = this.ctx.storage.sql
				.exec<{hash: string; createdAt: number}>(
					"SELECT hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at",
				)
				.toArray();
			const migrationRecord = migrationRecords[0];
			if (
				migrationRecords.length !== 1 ||
				migrationRecord === undefined ||
				migrationRecord.hash !== migrationHash ||
				migrationRecord.createdAt !== migration.when
			) {
				throw new Error("Durable Object migration ledger does not match the canonical baseline");
			}
			await this.database.insert(state).values({id: STATE_ROW_ID}).onConflictDoNothing();
		})();
		return this.initialization;
	}

	async createBatch(request: CreateBatchRequest): Promise<CreatedBatch> {
		await this.initialize();
		this.assertWritable();
		const now = Date.now();
		const batchId = crypto.randomUUID();
		// 🆔 Derived, not minted (spec appendix A.1): there is no reason for an id to be random.
		const questionRows = request.questions.map((question, position) => ({
			id: `${batchId}:${position}`,
			batchId,
			position,
			title: question.title,
			body: question.body,
		}));
		const activityRows: Array<typeof questionActivity.$inferInsert> = questionRows.map((question) => ({
			questionId: question.id,
			batchId,
			outcome: "outstanding",
			createdAt: now,
			outcomeAt: null,
		}));
		this.database.transaction((transaction) => {
			transaction
				.insert(batches)
				.values({
					id: batchId,
					project: request.project,
					repo: request.repo ?? null,
					branch: request.branch ?? null,
					worktree: request.worktree ?? null,
					directory: request.directory ?? null,
					createdAt: now,
					lastHeartbeatAt: now,
				})
				.run();
			transaction.insert(questions).values(questionRows).run();
			transaction.insert(questionActivity).values(activityRows).run();
		});
		// 💓 The heartbeat grace deadline always precedes retention; the alarm handler re-arms for both.
		await this.armAlarm(now + HEARTBEAT_GRACE_MILLISECONDS);
		await this.broadcastCurrentDeckState();
		return {batchId, questionIds: questionRows.map((row) => row.id)};
	}

	async retractBatch(batchId: string): Promise<boolean> {
		await this.initialize();
		this.assertWritable();
		if (!(await this.batchExists(batchId))) {
			return false;
		}
		if (isComplete(await this.batchDispositions(batchId))) {
			return false;
		}
		await this.deleteBatches(
			[batchId],
			TerminalActivityOutcome.Retracted,
			"batch_retracted",
			"the originating MCP call ended before the questions were answered",
			"batch retracted",
		);
		await this.armNextDeadline();
		return true;
	}

	async registerMcpRequest(requestKey: string, batchId: string): Promise<void> {
		await this.initialize();
		this.assertWritable();
		if (!(await this.batchExists(batchId))) {
			throw new Error("cannot register an MCP request for an unknown batch");
		}
		await this.ctx.storage.put(`${MCP_REQUEST_STORAGE_PREFIX}${requestKey}`, batchId);
	}

	async cancelMcpRequest(requestKey: string): Promise<boolean> {
		await this.initialize();
		this.assertWritable();
		const storageKey = `${MCP_REQUEST_STORAGE_PREFIX}${requestKey}`;
		const batchId = await this.ctx.storage.get<string>(storageKey);
		if (batchId === undefined) {
			return false;
		}
		const retracted = await this.retractBatch(batchId);
		await this.ctx.storage.delete(storageKey);
		return retracted;
	}

	async unregisterMcpRequest(requestKey: string, batchId: string): Promise<void> {
		const storageKey = `${MCP_REQUEST_STORAGE_PREFIX}${requestKey}`;
		if ((await this.ctx.storage.get<string>(storageKey)) === batchId) {
			await this.ctx.storage.delete(storageKey);
		}
	}

	async getAfk(hasActiveConnectedMcpClient: boolean): Promise<boolean> {
		await this.initialize();
		if (!hasActiveConnectedMcpClient) {
			return false;
		}
		const rows = await this.database.select({afk: state.afk}).from(state).where(eq(state.id, STATE_ROW_ID));
		return rows[0]?.afk ?? false;
	}

	async setAfk(afk: boolean, hasActiveConnectedMcpClient: boolean): Promise<AfkUpdateResult> {
		await this.initialize();
		this.assertWritable();
		if (afk && !hasActiveConnectedMcpClient) {
			return {
				status: "connected_mcp_client_required",
				message: "Authorize an MCP host or OAuth CLI client before turning AFK on.",
			};
		}
		await this.database.update(state).set({afk}).where(eq(state.id, STATE_ROW_ID));
		await this.broadcastCurrentDeckState();
		return {status: "updated", afk};
	}

	async synchronizeConnectedMcpClientAuthorizationState(
		connectedMcpClientAuthorizationState: ConnectedMcpClientAuthorizationState,
	): Promise<void> {
		await this.initialize();
		this.assertWritable();
		if (connectedMcpClientAuthorizationState.activeClientCount === 0) {
			await this.database.update(state).set({afk: false}).where(eq(state.id, STATE_ROW_ID));
		}
		for (const socket of this.ctx.getWebSockets(CURRENT_DECK_SOCKET_TAG)) {
			socket.serializeAttachment({
				connectedMcpClientAuthorizationState,
			} satisfies CurrentDeckSocketAttachment);
		}
		await this.broadcastCurrentDeckState();
	}

	async getCurrentQuestions(): Promise<CurrentQuestion[]> {
		await this.initialize();
		const oldestLiveCreation = Date.now() - RETENTION_MILLISECONDS;
		const rows = await this.database
			.select({
				batchId: batches.id,
				project: batches.project,
				repo: batches.repo,
				branch: batches.branch,
				worktree: batches.worktree,
				directory: batches.directory,
				questionId: questions.id,
				position: questions.position,
				title: questions.title,
				body: questions.body,
				createdAt: batches.createdAt,
			})
			.from(questions)
			.innerJoin(batches, eq(questions.batchId, batches.id))
			.leftJoin(answers, eq(answers.questionId, questions.id))
			.where(and(isNull(answers.questionId), sql`${batches.createdAt} > ${oldestLiveCreation}`))
			.orderBy(asc(batches.createdAt), asc(questions.position));
		return rows;
	}

	async getCurrentDeckState(
		connectedMcpClientAuthorizationState: ConnectedMcpClientAuthorizationState,
	): Promise<CurrentDeckState> {
		await this.initialize();
		const outstanding = await this.getCurrentQuestions();
		return {
			type: "current_deck",
			afk: await this.getAfk(connectedMcpClientAuthorizationState.activeClientCount > 0),
			connected_mcp_client_count: connectedMcpClientAuthorizationState.activeClientCount,
			current_deck: outstanding.map((question) => ({
				batch_id: question.batchId,
				project: question.project,
				repo: question.repo,
				branch: question.branch,
				worktree: question.worktree,
				directory: question.directory,
				question_id: question.questionId,
				position: question.position,
				title: question.title,
				body: question.body,
				created_at: question.createdAt,
			})),
		};
	}

	async getActivitySummary(): Promise<ActivitySummary> {
		await this.initialize();
		const summary: ActivitySummary = {
			total_questions: 0,
			outstanding: 0,
			yep: 0,
			nope: 0,
			skip: 0,
			retracted: 0,
			expired: 0,
		};
		const rows = await this.database
			.select({outcome: questionActivity.outcome, total: count()})
			.from(questionActivity)
			.groupBy(questionActivity.outcome);
		for (const row of rows) {
			switch (row.outcome) {
				case "outstanding":
					summary.outstanding = row.total;
					break;
				case "yep":
					summary.yep = row.total;
					break;
				case "nope":
					summary.nope = row.total;
					break;
				case "skip":
					summary.skip = row.total;
					break;
				case "retracted":
					summary.retracted = row.total;
					break;
				case "expired":
					summary.expired = row.total;
					break;
				default:
					throw new Error(`unknown activity outcome: ${row.outcome}`);
			}
			summary.total_questions += row.total;
		}
		return summary;
	}

	async submitAnswers(submitted: SubmittedAnswer[]): Promise<void> {
		await this.initialize();
		this.assertWritable();
		const affectedBatchIds = this.database.transaction((transaction) => {
			const questionIds = submitted.map((answer) => answer.question_id);
			if (new Set(questionIds).size !== questionIds.length) {
				throw new Error("duplicate_question: the same question_id appears twice in one request");
			}
			const found = transaction
				.select({id: questions.id, batchId: questions.batchId})
				.from(questions)
				.where(inArray(questions.id, questionIds))
				.all();
			const foundById = new Map(found.map((row) => [row.id, row]));
			for (const questionId of questionIds) {
				if (!foundById.has(questionId)) {
					throw new Error(`unknown_question: ${questionId}`);
				}
			}
			const alreadyAnswered = transaction
				.select({questionId: answers.questionId})
				.from(answers)
				.where(inArray(answers.questionId, questionIds))
				.all();
			if (alreadyAnswered.length > 0) {
				throw new Error(`already_answered: ${alreadyAnswered[0]?.questionId}`);
			}

			const now = Date.now();
			transaction
				.insert(answers)
				.values(
					submitted.map((answer) => ({
						questionId: answer.question_id,
						disposition: answer.disposition,
						answeredAt: now,
					})),
				)
				.run();
			for (const submittedAnswer of submitted) {
				transaction
					.update(questionActivity)
					.set({outcome: submittedAnswer.disposition, outcomeAt: now})
					.where(eq(questionActivity.questionId, submittedAnswer.question_id))
					.run();
			}
			return new Set(found.map((row) => row.batchId));
		});

		for (const batchId of affectedBatchIds) {
			await this.broadcastBatchState(batchId);
		}
		await this.broadcastCurrentDeckState();
	}

	// 🧪 Delivery seam: tests replace this to observe pushes without a live push service.
	pushTransport: (
		endpoint: string,
		request: {headers: Record<string, string>; body: Uint8Array},
	) => number | Promise<number> = async (endpoint, request) => {
		emitObservation(this.observationContext, "push.request", "input", {endpoint, request});
		try {
			const response = await fetch(endpoint, {method: "POST", headers: request.headers, body: request.body});
			const result = {
				status: response.status,
				statusText: response.statusText,
				headers: Array.from(response.headers.entries()),
				body: response.body === null ? null : await response.clone().arrayBuffer(),
			};
			emitObservation(this.observationContext, "push.response", "output", result);
			return response.status;
		} catch (error) {
			emitObservation(this.observationContext, "push.request", "failure", {endpoint, request, error}, "error");
			throw error;
		}
	};

	async registerDevice(subscription: PushSubscription, label: string): Promise<void> {
		await this.initialize();
		this.assertWritable();
		const serialized = JSON.stringify(subscription);
		await this.database
			.insert(devices)
			.values({
				id: await hashToken(subscription.endpoint),
				label,
				pushSubscription: serialized,
				createdAt: Date.now(),
			})
			.onConflictDoUpdate({target: devices.id, set: {pushSubscription: serialized}});
	}

	async listPushDevices(): Promise<PushDevice[]> {
		await this.initialize();
		return this.database
			.select({id: devices.id, label: devices.label, createdAt: devices.createdAt})
			.from(devices)
			.orderBy(asc(devices.createdAt), asc(devices.id));
	}

	async renamePushDevice(deviceId: string, label: string): Promise<boolean> {
		await this.initialize();
		this.assertWritable();
		const renamed = await this.database
			.update(devices)
			.set({label})
			.where(eq(devices.id, deviceId))
			.returning({id: devices.id});
		return renamed.length === 1;
	}

	async revokePushDevice(deviceId: string): Promise<boolean> {
		await this.initialize();
		this.assertWritable();
		const revoked = await this.database.delete(devices).where(eq(devices.id, deviceId)).returning({id: devices.id});
		return revoked.length === 1;
	}

	// 📣 One push per batch (spec §6.2). The service worker fetches question content after receipt,
	// so the encrypted push payload contains metadata only.
	async sendBatchPush(batchId: string): Promise<number> {
		await this.initialize();
		if (this.isMergeLocked()) {
			return 0;
		}
		const batchRows = await this.database
			.select({project: batches.project})
			.from(batches)
			.where(eq(batches.id, batchId));
		const batch = batchRows[0];
		if (batch === undefined) {
			return 0;
		}
		const batchQuestions = await this.database
			.select({id: questions.id})
			.from(questions)
			.where(eq(questions.batchId, batchId))
			.orderBy(asc(questions.position));
		const outstanding = (await this.getCurrentQuestions()).length;
		const payload = JSON.stringify({
			batch_id: batchId,
			project: batch.project,
			count: batchQuestions.length,
			outstanding,
		});

		const deviceRows = await this.database.select().from(devices);
		if (deviceRows.length === 0) {
			return 0;
		}
		const vapidPrivateJwk = parseVapidJwk(this.env.VAPID_PRIVATE_JWK);
		let delivered = 0;
		for (const device of deviceRows) {
			const stored: unknown = JSON.parse(device.pushSubscription);
			const subscription = pushSubscriptionSchema.safeParse(stored);
			if (!subscription.success) {
				await this.database.delete(devices).where(eq(devices.id, device.id));
				continue;
			}
			const request = await buildPushRequest({
				subscription: subscription.data,
				payload,
				vapidPrivateJwk,
				vapidSubject: this.env.VAPID_SUBJECT,
			});
			// 🚧 An unreachable push service must not fail the whole loop or the waitUntil.
			let status = 0;
			emitObservation(this.observationContext, "push.transport", "input", request);
			try {
				status = await this.pushTransport(request.endpoint, {headers: request.headers, body: request.body});
				emitObservation(this.observationContext, "push.transport", "output", {status});
			} catch (error) {
				emitObservation(this.observationContext, "push.transport", "failure", {request, error}, "error");
				status = 0;
			}
			if (status === 404 || status === 410) {
				// 🧹 The push service says this subscription is gone for good.
				if (!this.isMergeLocked()) {
					await this.database.delete(devices).where(eq(devices.id, device.id));
				}
			} else if (status >= 200 && status < 300) {
				delivered += 1;
			}
		}
		return delivered;
	}

	override async fetch(request: Request): Promise<Response> {
		return observeHttpExchange(this.observationContext, request, async (request) => {
			await this.initialize();
			const url = new URL(request.url);
			if (url.pathname === "/api/v1/current-deck/stream") {
				if (request.headers.get("Upgrade") !== "websocket") {
					return new Response(null, {status: 426});
				}
				const connectedMcpClientAuthorizationState = connectedMcpClientAuthorizationStateSchema.safeParse(
					JSON.parse(
						request.headers.get("X-YepNope-Connected-Mcp-Client-Authorization") ?? "null",
					) as unknown,
				);
				if (!connectedMcpClientAuthorizationState.success) {
					return new Response(null, {status: 400});
				}
				const pair = new WebSocketPair();
				this.ctx.acceptWebSocket(pair[1], [CURRENT_DECK_SOCKET_TAG]);
				pair[1].serializeAttachment({
					connectedMcpClientAuthorizationState: connectedMcpClientAuthorizationState.data,
				} satisfies CurrentDeckSocketAttachment);
				await this.sendCurrentDeckState(pair[1], connectedMcpClientAuthorizationState.data);
				return new Response(null, {status: 101, webSocket: pair[0]});
			}
			const match = /^\/api\/v1\/questions\/([^/]+)\/stream$/.exec(url.pathname);
			if (match === null) {
				return new Response(null, {status: 404});
			}
			if (request.headers.get("Upgrade") !== "websocket") {
				return new Response(null, {status: 426});
			}
			const batchId = match[1];
			if (batchId === undefined || !(await this.batchExists(batchId))) {
				return new Response(null, {status: 404});
			}
			const pair = new WebSocketPair();
			// 😴 Hibernation API: a held-open HTTP request is not hibernation eligible (spec §4.4).
			this.ctx.acceptWebSocket(pair[1], [batchId]);
			await this.sendCurrentState(pair[1], batchId);
			return new Response(null, {status: 101, webSocket: pair[0]});
		});
	}

	// 💓 Any inbound frame is a heartbeat (batch identifier option C in .llm/decisions.md).
	override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
		observeWebSocketFrame(this.observationContext, "inbound", message);
		try {
			await this.initialize();
			const batchId = this.ctx.getTags(socket)[0];
			if (batchId === CURRENT_DECK_SOCKET_TAG) {
				await this.sendCurrentDeckState(socket, this.getSocketConnectedMcpClientAuthorizationState(socket));
				return;
			}
			if (batchId === undefined || !(await this.batchExists(batchId))) {
				this.sendWebSocketFrame(
					socket,
					errorFrame(batchId ?? "unknown", {}, "unknown_batch", "this batch no longer exists"),
				);
				socket.close(1008, "unknown batch");
				return;
			}
			this.assertWritable();
			await this.database.update(batches).set({lastHeartbeatAt: Date.now()}).where(eq(batches.id, batchId));
			await this.sendCurrentState(socket, batchId);
		} catch (error) {
			emitObservation(this.observationContext, "websocket.message", "failure", error, "error");
			throw error;
		}
	}

	// 🗑️ The single DO alarm serves two deadlines: 7 day retention (spec §13.1) and
	// heartbeat-and-delete retraction (option C in .llm/decisions.md, spec §5).
	override async alarm(): Promise<void> {
		emitObservation(this.observationContext, "do.alarm", "input", null);
		try {
			await this.initialize();
			if (this.isMergeLocked()) {
				emitObservation(this.observationContext, "do.alarm", "output", {mergeLocked: true});
				return;
			}
			const now = Date.now();
			const expired = await this.database
				.select({id: batches.id})
				.from(batches)
				.where(lte(batches.createdAt, now - RETENTION_MILLISECONDS));
			await this.deleteBatches(
				expired.map((row) => row.id),
				TerminalActivityOutcome.Expired,
				"batch_expired",
				"this batch passed the 7 day retention limit",
				"batch expired",
			);
			// 💀 Unanswered questions whose agent stopped heartbeating: retract rather than let the
			// user answer into a void. Resolved batches keep their answers until retention so a
			// returning agent can still collect them.
			const stale = await this.database
				.selectDistinct({id: batches.id})
				.from(batches)
				.innerJoin(questions, eq(questions.batchId, batches.id))
				.leftJoin(answers, eq(answers.questionId, questions.id))
				.where(
					and(isNull(answers.questionId), lte(batches.lastHeartbeatAt, now - HEARTBEAT_GRACE_MILLISECONDS)),
				);
			await this.deleteBatches(
				stale.map((row) => row.id),
				TerminalActivityOutcome.Retracted,
				"batch_retracted",
				"the agent asking these questions stopped heartbeating",
				"batch retracted",
			);
			await this.armNextDeadline();
			emitObservation(this.observationContext, "do.alarm", "output", {mergeLocked: false});
		} catch (error) {
			emitObservation(this.observationContext, "do.alarm", "failure", error, "error");
			throw error;
		}
	}

	async prepareLegacyIdentityClaim(destinationUserId: string): Promise<LegacyIdentityPreparation> {
		await this.initialize();
		return this.database.transaction((transaction) => {
			const existingLock = transaction.select().from(identityMergeLock).where(eq(identityMergeLock.id, 1)).get();
			if (existingLock !== undefined && existingLock.destinationUserId !== destinationUserId) {
				return {status: "conflict", reason: "legacy identity is already being claimed by another account"};
			}
			transaction.insert(identityMergeLock).values({id: 1, destinationUserId}).onConflictDoNothing().run();
			const sourceState = transaction.select().from(state).where(eq(state.id, STATE_ROW_ID)).get();
			if (sourceState === undefined) {
				throw new Error("legacy identity state is missing");
			}
			return {
				status: "ready",
				snapshot: {
					devices: transaction.select().from(devices).all(),
					batches: transaction.select().from(batches).all(),
					questions: transaction.select().from(questions).all(),
					answers: transaction.select().from(answers).all(),
					questionActivity: transaction.select().from(questionActivity).all(),
				},
			};
		});
	}

	async mergeLegacyIdentity(
		sourceUserId: string,
		snapshot: LegacyIdentitySnapshot,
	): Promise<LegacyIdentityMergeResult> {
		await this.initialize();
		const result = this.database.transaction((transaction): LegacyIdentityMergeResult => {
			const imported = transaction
				.select({sourceUserId: identityMerges.sourceUserId})
				.from(identityMerges)
				.where(eq(identityMerges.sourceUserId, sourceUserId))
				.get();
			if (imported !== undefined) {
				return {status: "already_merged"};
			}
			if (transaction.select().from(identityMergeLock).where(eq(identityMergeLock.id, 1)).get() !== undefined) {
				return {status: "conflict", reason: "destination account is itself being merged"};
			}

			const conflicts = [
				findRowConflict(transaction.select().from(devices).all(), snapshot.devices, (row) => row.id),
				findRowConflict(transaction.select().from(batches).all(), snapshot.batches, (row) => row.id),
				findRowConflict(transaction.select().from(questions).all(), snapshot.questions, (row) => row.id),
				findRowConflict(transaction.select().from(answers).all(), snapshot.answers, (row) => row.questionId),
				findRowConflict(
					transaction.select().from(questionActivity).all(),
					snapshot.questionActivity,
					(row) => row.questionId,
				),
			].filter((conflict) => conflict !== null);
			if (conflicts[0] !== undefined) {
				return {status: "conflict", reason: conflicts[0]};
			}

			if (snapshot.devices.length > 0) {
				transaction.insert(devices).values(snapshot.devices).onConflictDoNothing().run();
			}
			if (snapshot.batches.length > 0) {
				transaction.insert(batches).values(snapshot.batches).onConflictDoNothing().run();
			}
			if (snapshot.questions.length > 0) {
				transaction.insert(questions).values(snapshot.questions).onConflictDoNothing().run();
			}
			if (snapshot.answers.length > 0) {
				transaction.insert(answers).values(snapshot.answers).onConflictDoNothing().run();
			}
			if (snapshot.questionActivity.length > 0) {
				transaction.insert(questionActivity).values(snapshot.questionActivity).onConflictDoNothing().run();
			}
			transaction
				.update(state)
				.set({
					afk: false,
				})
				.where(eq(state.id, STATE_ROW_ID))
				.run();
			transaction.insert(identityMerges).values({sourceUserId, importedAt: Date.now()}).run();
			return {status: "merged"};
		});
		if (result.status !== "conflict") {
			await this.armNextDeadline();
		}
		return result;
	}

	async clearClaimedLegacyIdentity(destinationUserId: string): Promise<void> {
		await this.initialize();
		const mergeLockTable = this.ctx.storage.sql
			.exec<{name: string}>(
				"SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'identity_merge_lock'",
			)
			.toArray()[0];
		if (mergeLockTable === undefined) {
			await this.deleteAll();
			return;
		}
		const lock = this.database.select().from(identityMergeLock).where(eq(identityMergeLock.id, 1)).get();
		if (lock !== undefined && lock.destinationUserId !== destinationUserId) {
			throw new Error("legacy identity claim lock does not match the destination account");
		}
		await this.deleteAll();
	}

	async getRedactedStorageDiagnostics(): Promise<RedactedStorageDiagnostics> {
		await this.initialize();
		const tables = this.ctx.storage.sql
			.exec<{name: string}>("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
			.toArray()
			.filter(({name}) => !name.startsWith("_cf_"));
		const tableCounts = tables.map(({name}) => {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
				throw new Error("Durable Object contains an unsupported table name");
			}
			const row = this.ctx.storage.sql.exec<{rows: number}>(`SELECT count(*) AS rows FROM "${name}"`).one();
			return {name, rows: row.rows};
		});
		return {alarm_set: (await this.ctx.storage.getAlarm()) !== null, table_counts: tableCounts};
	}

	async deleteAll(): Promise<{deleted: true}> {
		for (const socket of this.ctx.getWebSockets()) {
			socket.close(1000, "identity deleted");
		}
		await this.ctx.storage.deleteAll();
		return {deleted: true};
	}

	async releaseLegacyIdentityClaim(destinationUserId: string): Promise<void> {
		await this.initialize();
		this.database
			.delete(identityMergeLock)
			.where(and(eq(identityMergeLock.id, 1), eq(identityMergeLock.destinationUserId, destinationUserId)))
			.run();
	}

	private async deleteBatches(
		batchIds: string[],
		activityOutcome: TerminalActivityOutcome,
		code: string,
		message: string,
		closeReason: string,
	): Promise<void> {
		if (batchIds.length === 0) {
			return;
		}
		const socketClosures: Array<{sockets: WebSocket[]; frame: string}> = [];
		for (const batchId of batchIds) {
			const dispositions = await this.batchDispositions(batchId);
			socketClosures.push({
				sockets: this.ctx.getWebSockets(batchId),
				frame: errorFrame(batchId, dispositions, code, message),
			});
		}
		const doomedQuestions = await this.database
			.select({id: questions.id})
			.from(questions)
			.where(inArray(questions.batchId, batchIds));
		const doomedQuestionIds = doomedQuestions.map((row) => row.id);
		this.database.transaction((transaction) => {
			if (doomedQuestionIds.length > 0) {
				transaction
					.update(questionActivity)
					.set({outcome: activityOutcome, outcomeAt: Date.now()})
					.where(
						and(
							inArray(questionActivity.questionId, doomedQuestionIds),
							eq(questionActivity.outcome, "outstanding"),
						),
					)
					.run();
				transaction.delete(answers).where(inArray(answers.questionId, doomedQuestionIds)).run();
			}
			transaction.delete(questions).where(inArray(questions.batchId, batchIds)).run();
			transaction.delete(batches).where(inArray(batches.id, batchIds)).run();
		});
		for (const closure of socketClosures) {
			for (const socket of closure.sockets) {
				this.sendWebSocketFrame(socket, closure.frame);
				socket.close(1000, closeReason);
			}
		}
		await this.broadcastCurrentDeckState();
	}

	private isMergeLocked(): boolean {
		return this.database.select({id: identityMergeLock.id}).from(identityMergeLock).limit(1).get() !== undefined;
	}

	private assertWritable(): void {
		if (this.isMergeLocked()) {
			throw new Error("identity_merge_in_progress: this legacy identity is being moved to an account");
		}
	}

	// ⏰ Re-arm for whichever deadline comes sooner: retention on any batch, or heartbeat
	// staleness on a batch that still has unanswered questions.
	private async armNextDeadline(): Promise<void> {
		const oldestCreated = await this.database.select({value: min(batches.createdAt)}).from(batches);
		const oldestUnresolvedHeartbeat = await this.database
			.select({value: min(batches.lastHeartbeatAt)})
			.from(batches)
			.innerJoin(questions, eq(questions.batchId, batches.id))
			.leftJoin(answers, eq(answers.questionId, questions.id))
			.where(isNull(answers.questionId));
		const deadlines: number[] = [];
		const createdAt = oldestCreated[0]?.value;
		if (createdAt !== null && createdAt !== undefined) {
			deadlines.push(createdAt + RETENTION_MILLISECONDS);
		}
		const heartbeatAt = oldestUnresolvedHeartbeat[0]?.value;
		if (heartbeatAt !== null && heartbeatAt !== undefined) {
			deadlines.push(heartbeatAt + HEARTBEAT_GRACE_MILLISECONDS);
		}
		if (deadlines.length > 0) {
			await this.ctx.storage.setAlarm(Math.min(...deadlines));
		}
	}

	private async armAlarm(expiry: number): Promise<void> {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > expiry) {
			await this.ctx.storage.setAlarm(expiry);
		}
	}

	private async batchExists(batchId: string): Promise<boolean> {
		const rows = await this.database.select({id: batches.id}).from(batches).where(eq(batches.id, batchId));
		return rows.length > 0;
	}

	private async batchDispositions(batchId: string): Promise<DispositionMap> {
		const rows = await this.database
			.select({questionId: questions.id, disposition: answers.disposition})
			.from(questions)
			.leftJoin(answers, eq(answers.questionId, questions.id))
			.where(eq(questions.batchId, batchId))
			.orderBy(asc(questions.position));
		const dispositions: DispositionMap = {};
		for (const row of rows) {
			dispositions[row.questionId] = row.disposition === null ? null : dispositionSchema.parse(row.disposition);
		}
		return dispositions;
	}

	private async sendCurrentState(socket: WebSocket, batchId: string): Promise<void> {
		const dispositions = await this.batchDispositions(batchId);
		if (isComplete(dispositions)) {
			this.sendWebSocketFrame(socket, resolvedFrame(batchId, dispositions));
			socket.close(1000, "resolved");
			return;
		}
		this.sendWebSocketFrame(socket, stateFrame(batchId, dispositions));
	}

	private async sendCurrentDeckState(
		socket: WebSocket,
		connectedMcpClientAuthorizationState: ConnectedMcpClientAuthorizationState,
	): Promise<void> {
		this.sendWebSocketFrame(
			socket,
			JSON.stringify(await this.getCurrentDeckState(connectedMcpClientAuthorizationState)),
		);
	}

	private async broadcastCurrentDeckState(): Promise<void> {
		const sockets = this.ctx.getWebSockets(CURRENT_DECK_SOCKET_TAG);
		if (sockets.length === 0) {
			return;
		}
		for (const socket of sockets) {
			await this.sendCurrentDeckState(socket, this.getSocketConnectedMcpClientAuthorizationState(socket));
		}
	}

	private getSocketConnectedMcpClientAuthorizationState(socket: WebSocket): ConnectedMcpClientAuthorizationState {
		return currentDeckSocketAttachmentSchema.parse(socket.deserializeAttachment())
			.connectedMcpClientAuthorizationState;
	}

	private async broadcastBatchState(batchId: string): Promise<void> {
		const dispositions = await this.batchDispositions(batchId);
		const complete = isComplete(dispositions);
		const frame = complete ? resolvedFrame(batchId, dispositions) : stateFrame(batchId, dispositions);
		for (const socket of this.ctx.getWebSockets(batchId)) {
			this.sendWebSocketFrame(socket, frame);
			if (complete) {
				socket.close(1000, "resolved");
			}
		}
	}

	private sendWebSocketFrame(socket: WebSocket, frame: string | ArrayBuffer | ArrayBufferView): void {
		if (socket.readyState !== WebSocket.OPEN) {
			return;
		}
		observeWebSocketFrame(this.observationContext, "outbound", frame);
		socket.send(frame);
	}
}
