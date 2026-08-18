// fallow-ignore-file unused-class-member -- RPC methods are invoked through DurableObjectStub, which fallow cannot trace
import {DurableObject} from "cloudflare:workers";
import {and, asc, eq, inArray, isNull, lte, min, sql} from "drizzle-orm";
import {drizzle, type DrizzleSqliteDODatabase} from "drizzle-orm/durable-sqlite";
import {migrate} from "drizzle-orm/durable-sqlite/migrator";
import {answers, batches, devices, identityMergeLock, identityMerges, questions, state} from "./db/do-schema";
import migrationBundle from "./migrations/do/migrations.js";
import {hashToken} from "./auth";
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

export interface OutstandingQuestion {
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

export interface OutstandingQuestionPayload {
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

export interface OutstandingQuestionState {
	type: "questions";
	questions: OutstandingQuestionPayload[];
}

export interface SubmittedAnswer {
	question_id: string;
	disposition: Disposition;
}

export interface LegacyIdentitySnapshot {
	state: {
		afk: boolean;
		questionsAsked: number;
		yepCount: number;
		nopeCount: number;
		skipCount: number;
	};
	devices: Array<typeof devices.$inferSelect>;
	batches: Array<typeof batches.$inferSelect>;
	questions: Array<typeof questions.$inferSelect>;
	answers: Array<typeof answers.$inferSelect>;
}

export type LegacyIdentityPreparation =
	| {status: "ready"; snapshot: LegacyIdentitySnapshot}
	| {status: "conflict"; reason: string};

export type LegacyIdentityMergeResult =
	| {status: "merged"}
	| {status: "already_merged"}
	| {status: "conflict"; reason: string};

const STATE_ROW_ID = 1;
const QUESTIONS_SOCKET_TAG = "questions";

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

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.database = drizzle(ctx.storage);
		// ⏳ Schema setup only: each DO migrates itself forward on wake (spec §4.1).
		void ctx.blockConcurrencyWhile(async () => {
			await migrate(this.database, migrationBundle);
			await this.database.insert(state).values({id: STATE_ROW_ID}).onConflictDoNothing();
		});
	}

	async createBatch(request: CreateBatchRequest): Promise<CreatedBatch> {
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
			// 📊 Quota bookkeeping only: enforcement is cut from the MVP (spec §17).
			transaction
				.update(state)
				.set({questionsAsked: sql`${state.questionsAsked} + ${questionRows.length}`})
				.where(eq(state.id, STATE_ROW_ID))
				.run();
		});
		// 💓 The heartbeat grace deadline always precedes retention; the alarm handler re-arms for both.
		await this.armAlarm(now + HEARTBEAT_GRACE_MILLISECONDS);
		await this.broadcastOutstandingQuestionState();
		return {batchId, questionIds: questionRows.map((row) => row.id)};
	}

	async getAfk(): Promise<boolean> {
		const rows = await this.database.select({afk: state.afk}).from(state).where(eq(state.id, STATE_ROW_ID));
		return rows[0]?.afk ?? true;
	}

	async setAfk(afk: boolean): Promise<void> {
		this.assertWritable();
		await this.database.update(state).set({afk}).where(eq(state.id, STATE_ROW_ID));
	}

	async getOutstandingQuestions(): Promise<OutstandingQuestion[]> {
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

	async getOutstandingQuestionState(): Promise<OutstandingQuestionState> {
		const outstanding = await this.getOutstandingQuestions();
		return {
			type: "questions",
			questions: outstanding.map((question) => ({
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

	async submitAnswers(submitted: SubmittedAnswer[]): Promise<void> {
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
			const counts = {yep: 0, nope: 0, skip: 0};
			for (const answer of submitted) {
				counts[answer.disposition] += 1;
			}
			transaction
				.update(state)
				.set({
					yepCount: sql`${state.yepCount} + ${counts.yep}`,
					nopeCount: sql`${state.nopeCount} + ${counts.nope}`,
					skipCount: sql`${state.skipCount} + ${counts.skip}`,
				})
				.where(eq(state.id, STATE_ROW_ID))
				.run();
			return new Set(found.map((row) => row.batchId));
		});

		for (const batchId of affectedBatchIds) {
			await this.broadcastBatchState(batchId);
		}
		await this.broadcastOutstandingQuestionState();
	}

	// 🧪 Delivery seam: tests replace this to observe pushes without a live push service.
	pushTransport: (
		endpoint: string,
		request: {headers: Record<string, string>; body: Uint8Array},
	) => number | Promise<number> = async (endpoint, request) => {
		const response = await fetch(endpoint, {method: "POST", headers: request.headers, body: request.body});
		return response.status;
	};

	async registerDevice(subscription: PushSubscription): Promise<void> {
		this.assertWritable();
		const serialized = JSON.stringify(subscription);
		await this.database
			.insert(devices)
			.values({id: await hashToken(subscription.endpoint), pushSubscription: serialized, createdAt: Date.now()})
			.onConflictDoUpdate({target: devices.id, set: {pushSubscription: serialized}});
	}

	// 📣 One push per batch (spec §6.2). The service worker fetches question content after receipt,
	// so the encrypted push payload contains metadata only.
	async sendBatchPush(batchId: string): Promise<number> {
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
		const outstanding = (await this.getOutstandingQuestions()).length;
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
			try {
				status = await this.pushTransport(request.endpoint, {headers: request.headers, body: request.body});
			} catch {
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
		const url = new URL(request.url);
		if (url.pathname === "/api/v1/questions/stream") {
			if (request.headers.get("Upgrade") !== "websocket") {
				return new Response(null, {status: 426});
			}
			const pair = new WebSocketPair();
			this.ctx.acceptWebSocket(pair[1], [QUESTIONS_SOCKET_TAG]);
			await this.sendOutstandingQuestionState(pair[1]);
			const selectedProtocol = request.headers.get("Sec-WebSocket-Protocol")?.startsWith("yepnope,") === true;
			return selectedProtocol
				? new Response(null, {
						status: 101,
						webSocket: pair[0],
						headers: {"Sec-WebSocket-Protocol": "yepnope"},
					})
				: new Response(null, {status: 101, webSocket: pair[0]});
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
	}

	// 💓 Any inbound frame is a heartbeat (batch identifier option C in .llm/decisions.md).
	override async webSocketMessage(socket: WebSocket, _message: string | ArrayBuffer): Promise<void> {
		const batchId = this.ctx.getTags(socket)[0];
		if (batchId === QUESTIONS_SOCKET_TAG) {
			await this.sendOutstandingQuestionState(socket);
			return;
		}
		if (batchId === undefined || !(await this.batchExists(batchId))) {
			socket.send(errorFrame(batchId ?? "unknown", {}, "unknown_batch", "this batch no longer exists"));
			socket.close(1008, "unknown batch");
			return;
		}
		this.assertWritable();
		await this.database.update(batches).set({lastHeartbeatAt: Date.now()}).where(eq(batches.id, batchId));
		await this.sendCurrentState(socket, batchId);
	}

	// 🗑️ The single DO alarm serves two deadlines: 7 day retention (spec §13.1) and
	// heartbeat-and-delete retraction (option C in .llm/decisions.md, spec §5).
	override async alarm(): Promise<void> {
		if (this.isMergeLocked()) {
			return;
		}
		const now = Date.now();
		const expired = await this.database
			.select({id: batches.id})
			.from(batches)
			.where(lte(batches.createdAt, now - RETENTION_MILLISECONDS));
		await this.deleteBatches(
			expired.map((row) => row.id),
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
			.where(and(isNull(answers.questionId), lte(batches.lastHeartbeatAt, now - HEARTBEAT_GRACE_MILLISECONDS)));
		await this.deleteBatches(
			stale.map((row) => row.id),
			"batch_retracted",
			"the agent asking these questions stopped heartbeating",
			"batch retracted",
		);
		await this.armNextDeadline();
	}

	prepareLegacyIdentityClaim(destinationUserId: string): LegacyIdentityPreparation {
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
					state: {
						afk: sourceState.afk,
						questionsAsked: sourceState.questionsAsked,
						yepCount: sourceState.yepCount,
						nopeCount: sourceState.nopeCount,
						skipCount: sourceState.skipCount,
					},
					devices: transaction.select().from(devices).all(),
					batches: transaction.select().from(batches).all(),
					questions: transaction.select().from(questions).all(),
					answers: transaction.select().from(answers).all(),
				},
			};
		});
	}

	async mergeLegacyIdentity(
		sourceUserId: string,
		snapshot: LegacyIdentitySnapshot,
	): Promise<LegacyIdentityMergeResult> {
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
			transaction
				.update(state)
				.set({
					afk: sql`${state.afk} OR ${snapshot.state.afk}`,
					questionsAsked: sql`${state.questionsAsked} + ${snapshot.state.questionsAsked}`,
					yepCount: sql`${state.yepCount} + ${snapshot.state.yepCount}`,
					nopeCount: sql`${state.nopeCount} + ${snapshot.state.nopeCount}`,
					skipCount: sql`${state.skipCount} + ${snapshot.state.skipCount}`,
				})
				.where(eq(state.id, STATE_ROW_ID))
				.run();
			transaction.insert(identityMerges).values({sourceUserId, importedAt: Date.now()}).run();
			return {status: "merged"};
		});
		if (result.status !== "conflict") {
			await this.armNextDeadline();
			await this.broadcastOutstandingQuestionState();
		}
		return result;
	}

	async clearClaimedLegacyIdentity(destinationUserId: string): Promise<void> {
		const mergeLockTable = this.ctx.storage.sql
			.exec<{name: string}>(
				"SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'identity_merge_lock'",
			)
			.toArray()[0];
		if (mergeLockTable === undefined) {
			await this.deleteStorageForCleanup();
			return;
		}
		const lock = this.database.select().from(identityMergeLock).where(eq(identityMergeLock.id, 1)).get();
		if (lock !== undefined && lock.destinationUserId !== destinationUserId) {
			throw new Error("legacy identity claim lock does not match the destination account");
		}
		await this.deleteStorageForCleanup();
	}

	async deleteStorageForCleanup(): Promise<{deleted: true}> {
		for (const socket of this.ctx.getWebSockets()) {
			socket.close(1000, "identity deleted");
		}
		await this.ctx.storage.deleteAll();
		return {deleted: true};
	}

	releaseLegacyIdentityClaim(destinationUserId: string): void {
		this.database
			.delete(identityMergeLock)
			.where(and(eq(identityMergeLock.id, 1), eq(identityMergeLock.destinationUserId, destinationUserId)))
			.run();
	}

	private async deleteBatches(batchIds: string[], code: string, message: string, closeReason: string): Promise<void> {
		if (batchIds.length === 0) {
			return;
		}
		for (const batchId of batchIds) {
			const dispositions = await this.batchDispositions(batchId);
			const closeFrame = errorFrame(batchId, dispositions, code, message);
			for (const socket of this.ctx.getWebSockets(batchId)) {
				socket.send(closeFrame);
				socket.close(1000, closeReason);
			}
		}
		const doomedQuestions = await this.database
			.select({id: questions.id})
			.from(questions)
			.where(inArray(questions.batchId, batchIds));
		const doomedQuestionIds = doomedQuestions.map((row) => row.id);
		if (doomedQuestionIds.length > 0) {
			await this.database.delete(answers).where(inArray(answers.questionId, doomedQuestionIds));
		}
		await this.database.delete(questions).where(inArray(questions.batchId, batchIds));
		await this.database.delete(batches).where(inArray(batches.id, batchIds));
		await this.broadcastOutstandingQuestionState();
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
			socket.send(resolvedFrame(batchId, dispositions));
			socket.close(1000, "resolved");
			return;
		}
		socket.send(stateFrame(batchId, dispositions));
	}

	private async sendOutstandingQuestionState(socket: WebSocket): Promise<void> {
		socket.send(JSON.stringify(await this.getOutstandingQuestionState()));
	}

	private async broadcastOutstandingQuestionState(): Promise<void> {
		const sockets = this.ctx.getWebSockets(QUESTIONS_SOCKET_TAG);
		if (sockets.length === 0) {
			return;
		}
		const frame = JSON.stringify(await this.getOutstandingQuestionState());
		for (const socket of sockets) {
			socket.send(frame);
		}
	}

	private async broadcastBatchState(batchId: string): Promise<void> {
		const dispositions = await this.batchDispositions(batchId);
		const complete = isComplete(dispositions);
		const frame = complete ? resolvedFrame(batchId, dispositions) : stateFrame(batchId, dispositions);
		for (const socket of this.ctx.getWebSockets(batchId)) {
			socket.send(frame);
			if (complete) {
				socket.close(1000, "resolved");
			}
		}
	}
}
