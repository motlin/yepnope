// fallow-ignore-file unused-class-member -- RPC methods are invoked through DurableObjectStub, which fallow cannot trace
import {DurableObject} from "cloudflare:workers";
import {and, asc, eq, inArray, isNull, lte, min, sql} from "drizzle-orm";
import {drizzle, type DrizzleSqliteDODatabase} from "drizzle-orm/durable-sqlite";
import {migrate} from "drizzle-orm/durable-sqlite/migrator";
import {answers, batches, devices, questions, state} from "./db/do-schema";
import migrationBundle from "./migrations/do/migrations.js";
import {errorFrame, isComplete, resolvedFrame, stateFrame, type DispositionMap} from "./protocol";
import {dispositionSchema, RETENTION_MILLISECONDS, type CreateBatchRequest, type Disposition} from "./validation";

export interface CreatedBatch {
	batchId: string;
	questionIds: string[];
}

export interface OutstandingQuestion {
	batchId: string;
	project: string;
	questionId: string;
	position: number;
	title: string;
	body: string;
	createdAt: number;
}

export interface SubmittedAnswer {
	question_id: string;
	disposition: Disposition;
}

const STATE_ROW_ID = 1;

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
		const now = Date.now();
		const batchId = crypto.randomUUID();
		const questionRows = request.questions.map((question, position) => ({
			id: crypto.randomUUID(),
			batchId,
			position,
			title: question.title,
			body: question.body,
		}));
		await this.database
			.insert(batches)
			.values({id: batchId, project: request.project, createdAt: now, lastHeartbeatAt: now});
		await this.database.insert(questions).values(questionRows);
		// 📊 Quota bookkeeping only: enforcement is cut from the MVP (spec §17).
		await this.database
			.update(state)
			.set({questionsAsked: sql`${state.questionsAsked} + ${questionRows.length}`})
			.where(eq(state.id, STATE_ROW_ID));
		await this.armRetentionAlarm(now + RETENTION_MILLISECONDS);
		return {batchId, questionIds: questionRows.map((row) => row.id)};
	}

	async getOutstandingQuestions(): Promise<OutstandingQuestion[]> {
		const oldestLiveCreation = Date.now() - RETENTION_MILLISECONDS;
		const rows = await this.database
			.select({
				batchId: batches.id,
				project: batches.project,
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

	async submitAnswers(submitted: SubmittedAnswer[]): Promise<void> {
		const questionIds = submitted.map((answer) => answer.question_id);
		if (new Set(questionIds).size !== questionIds.length) {
			throw new Error("duplicate_question: the same question_id appears twice in one request");
		}
		const found = await this.database
			.select({id: questions.id, batchId: questions.batchId})
			.from(questions)
			.where(inArray(questions.id, questionIds));
		const foundById = new Map(found.map((row) => [row.id, row]));
		for (const questionId of questionIds) {
			if (!foundById.has(questionId)) {
				throw new Error(`unknown_question: ${questionId}`);
			}
		}
		const alreadyAnswered = await this.database
			.select({questionId: answers.questionId})
			.from(answers)
			.where(inArray(answers.questionId, questionIds));
		if (alreadyAnswered.length > 0) {
			throw new Error(`already_answered: ${alreadyAnswered[0]?.questionId}`);
		}

		const now = Date.now();
		await this.database.insert(answers).values(
			submitted.map((answer) => ({
				questionId: answer.question_id,
				disposition: answer.disposition,
				answeredAt: now,
			})),
		);
		const counts = {yep: 0, nope: 0, skip: 0};
		for (const answer of submitted) {
			counts[answer.disposition] += 1;
		}
		await this.database
			.update(state)
			.set({
				yepCount: sql`${state.yepCount} + ${counts.yep}`,
				nopeCount: sql`${state.nopeCount} + ${counts.nope}`,
				skipCount: sql`${state.skipCount} + ${counts.skip}`,
			})
			.where(eq(state.id, STATE_ROW_ID));

		const affectedBatchIds = new Set(found.map((row) => row.batchId));
		for (const batchId of affectedBatchIds) {
			await this.broadcastBatchState(batchId);
		}
	}

	// 📣 Push delivery lands with the PWA (build plan days 4 to 6); until devices register this pushes to nobody.
	async sendBatchPush(_batchId: string): Promise<number> {
		const rows = await this.database.select({id: devices.id}).from(devices);
		return rows.length;
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
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
		if (batchId === undefined || !(await this.batchExists(batchId))) {
			socket.send(errorFrame("unknown_batch", "this batch no longer exists"));
			socket.close(1008, "unknown batch");
			return;
		}
		await this.database.update(batches).set({lastHeartbeatAt: Date.now()}).where(eq(batches.id, batchId));
		await this.sendCurrentState(socket, batchId);
	}

	// 🗑️ Seven-day retention via the single DO alarm (spec §13.1).
	override async alarm(): Promise<void> {
		const now = Date.now();
		const expired = await this.database
			.select({id: batches.id})
			.from(batches)
			.where(lte(batches.createdAt, now - RETENTION_MILLISECONDS));
		const expiredBatchIds = expired.map((row) => row.id);
		if (expiredBatchIds.length > 0) {
			for (const batchId of expiredBatchIds) {
				for (const socket of this.ctx.getWebSockets(batchId)) {
					socket.send(errorFrame("batch_expired", "this batch passed the 7 day retention limit"));
					socket.close(1000, "batch expired");
				}
			}
			const expiredQuestions = await this.database
				.select({id: questions.id})
				.from(questions)
				.where(inArray(questions.batchId, expiredBatchIds));
			const expiredQuestionIds = expiredQuestions.map((row) => row.id);
			if (expiredQuestionIds.length > 0) {
				await this.database.delete(answers).where(inArray(answers.questionId, expiredQuestionIds));
			}
			await this.database.delete(questions).where(inArray(questions.batchId, expiredBatchIds));
			await this.database.delete(batches).where(inArray(batches.id, expiredBatchIds));
		}
		const oldest = await this.database.select({createdAt: min(batches.createdAt)}).from(batches);
		const oldestCreatedAt = oldest[0]?.createdAt;
		if (oldestCreatedAt !== null && oldestCreatedAt !== undefined) {
			await this.ctx.storage.setAlarm(oldestCreatedAt + RETENTION_MILLISECONDS);
		}
	}

	private async armRetentionAlarm(expiry: number): Promise<void> {
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
