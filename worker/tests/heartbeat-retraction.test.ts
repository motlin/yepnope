import {runDurableObjectAlarm, runInDurableObject} from "cloudflare:test";
import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import type {Frame} from "../protocol";
import {HEARTBEAT_GRACE_MILLISECONDS, RETENTION_MILLISECONDS} from "../validation";
import {
	API_ORIGIN,
	createBatchOverHttp,
	nextMessage,
	postAnswers,
	registerMachineToken,
	required,
	worker,
} from "./helpers";

async function openStream(token: string, batchId: string): Promise<WebSocket> {
	const response = await worker.fetch(`${API_ORIGIN}/api/v1/questions/${batchId}/stream`, {
		headers: {Authorization: `Bearer ${token}`, Upgrade: "websocket"},
	});
	return required(response.webSocket ?? undefined, "websocket on the upgrade response");
}

async function openQuestionStream(token: string): Promise<WebSocket> {
	const response = await worker.fetch(`${API_ORIGIN}/api/v1/questions/stream`, {
		headers: {Authorization: `Bearer ${token}`, Upgrade: "websocket"},
	});
	return required(response.webSocket ?? undefined, "question websocket on the upgrade response");
}

async function goStale(stub: DurableObjectStub, batchId: string): Promise<void> {
	return runInDurableObject(stub, (_instance, state) => {
		state.storage.sql.exec(
			"UPDATE batches SET last_heartbeat_at = last_heartbeat_at - ? WHERE id = ?",
			HEARTBEAT_GRACE_MILLISECONDS + 60_000,
			batchId,
		);
	});
}

describe("heartbeat and delete (batch identifier option C)", () => {
	it("arms the alarm at the heartbeat grace deadline on batch insert", async () => {
		const userId = "heartbeat-arm";
		const token = await registerMachineToken(userId);
		const before = Date.now();
		await createBatchOverHttp(token, "demo", [{title: "Keep?", body: ""}]);

		const stub = env.USER_DO.getByName(userId);
		await runInDurableObject(stub, async (_instance, state) => {
			const alarm = await state.storage.getAlarm();
			expect(alarm).toBeGreaterThanOrEqual(before + HEARTBEAT_GRACE_MILLISECONDS);
			expect(alarm).toBeLessThanOrEqual(Date.now() + HEARTBEAT_GRACE_MILLISECONDS);
		});
	});

	it("retracts an unresolved batch whose heartbeats stopped and tells open sockets", async () => {
		const userId = "heartbeat-retract";
		const token = await registerMachineToken(userId);
		const created = await createBatchOverHttp(token, "demo", [{title: "Anyone there?", body: ""}]);

		const socket = await openStream(token, created.batch_id);
		const initialFrame = nextMessage(socket);
		socket.accept();
		await initialFrame;

		const stub = env.USER_DO.getByName(userId);
		await goStale(stub, created.batch_id);

		const retractionFrame = nextMessage(socket);
		expect(await runDurableObjectAlarm(stub)).toBe(true);

		const frame = JSON.parse(await retractionFrame) as Frame;
		const questionId = required(created.question_ids[0], "question id");
		expect(frame).toStrictEqual({
			type: "error",
			batch_id: created.batch_id,
			dispositions: {[questionId]: null},
			code: "batch_retracted",
			message: "the agent asking these questions stopped heartbeating",
		});

		await runInDurableObject(stub, async (_instance, state) => {
			expect(state.storage.sql.exec("SELECT COUNT(*) AS total FROM batches").one()["total"]).toBe(0);
			expect(state.storage.sql.exec("SELECT COUNT(*) AS total FROM questions").one()["total"]).toBe(0);
			expect(await state.storage.getAlarm()).toBeNull();
		});
	});

	it("publishes an empty card state to the open PWA stream when a batch is retracted", async () => {
		const userId = "heartbeat-live-pwa";
		const token = await registerMachineToken(userId);
		const created = await createBatchOverHttp(token, "demo", [{title: "Anyone there?", body: ""}]);
		const socket = await openQuestionStream(token);
		const initialMessage = nextMessage(socket);
		socket.accept();
		expect(JSON.parse(await initialMessage)).toStrictEqual({
			type: "questions",
			afk: true,
			paired: true,
			machine_count: 1,
			questions: [
				{
					batch_id: created.batch_id,
					project: "demo",
					repo: null,
					branch: null,
					worktree: null,
					directory: null,
					question_id: created.question_ids[0],
					position: 0,
					title: "Anyone there?",
					body: "",
					created_at: expect.any(Number) as number,
				},
			],
		});

		const stub = env.USER_DO.getByName(userId);
		await goStale(stub, created.batch_id);
		const retractedMessage = nextMessage(socket);
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(JSON.parse(await retractedMessage)).toStrictEqual({
			type: "questions",
			afk: true,
			paired: true,
			machine_count: 1,
			questions: [],
		});
		socket.close();
	});

	it("keeps a resolved batch until retention even after heartbeats stop", async () => {
		const userId = "heartbeat-resolved";
		const token = await registerMachineToken(userId);
		const created = await createBatchOverHttp(token, "demo", [{title: "Ship?", body: ""}]);
		const questionId = required(created.question_ids[0], "question id");
		await postAnswers(token, [{question_id: questionId, disposition: "yep"}]);

		const stub = env.USER_DO.getByName(userId);
		await goStale(stub, created.batch_id);
		expect(await runDurableObjectAlarm(stub)).toBe(true);

		await runInDurableObject(stub, async (_instance, state) => {
			expect(state.storage.sql.exec("SELECT COUNT(*) AS total FROM batches").one()["total"]).toBe(1);
			expect(state.storage.sql.exec("SELECT COUNT(*) AS total FROM answers").one()["total"]).toBe(1);
			const createdAt = required(
				state.storage.sql.exec("SELECT created_at FROM batches").one()["created_at"],
				"created_at",
			) as number;
			expect(await state.storage.getAlarm()).toBe(createdAt + RETENTION_MILLISECONDS);
		});
	});

	it("keeps a batch alive when a heartbeat arrives inside the grace period", async () => {
		const userId = "heartbeat-refresh";
		const token = await registerMachineToken(userId);
		const created = await createBatchOverHttp(token, "demo", [{title: "Still here?", body: ""}]);

		const stub = env.USER_DO.getByName(userId);
		await goStale(stub, created.batch_id);

		const socket = await openStream(token, created.batch_id);
		const initialFrame = nextMessage(socket);
		socket.accept();
		await initialFrame;
		const heartbeatReply = nextMessage(socket);
		socket.send(JSON.stringify({type: "heartbeat"}));
		await heartbeatReply;

		expect(await runDurableObjectAlarm(stub)).toBe(true);

		await runInDurableObject(stub, async (_instance, state) => {
			expect(state.storage.sql.exec("SELECT COUNT(*) AS total FROM batches").one()["total"]).toBe(1);
			const lastHeartbeatAt = required(
				state.storage.sql.exec("SELECT last_heartbeat_at FROM batches").one()["last_heartbeat_at"],
				"last_heartbeat_at",
			) as number;
			expect(await state.storage.getAlarm()).toBe(lastHeartbeatAt + HEARTBEAT_GRACE_MILLISECONDS);
		});
	});

	it("returns 404 for answers submitted after retraction", async () => {
		const userId = "heartbeat-late-answer";
		const token = await registerMachineToken(userId);
		const created = await createBatchOverHttp(token, "demo", [{title: "Too late?", body: ""}]);
		const questionId = required(created.question_ids[0], "question id");

		const stub = env.USER_DO.getByName(userId);
		await goStale(stub, created.batch_id);
		expect(await runDurableObjectAlarm(stub)).toBe(true);

		const response = await postAnswers(token, [{question_id: questionId, disposition: "yep"}]);
		expect(response.status).toBe(404);
	});

	it("discards partial answers with the retracted batch and leaves counters alone", async () => {
		const userId = "heartbeat-partial";
		const token = await registerMachineToken(userId);
		const created = await createBatchOverHttp(token, "demo", [
			{title: "First?", body: ""},
			{title: "Second?", body: ""},
		]);
		const firstQuestionId = required(created.question_ids[0], "first question id");
		await postAnswers(token, [{question_id: firstQuestionId, disposition: "yep"}]);

		const stub = env.USER_DO.getByName(userId);
		await goStale(stub, created.batch_id);
		expect(await runDurableObjectAlarm(stub)).toBe(true);

		await runInDurableObject(stub, (_instance, state) => {
			expect(state.storage.sql.exec("SELECT COUNT(*) AS total FROM batches").one()["total"]).toBe(0);
			expect(state.storage.sql.exec("SELECT COUNT(*) AS total FROM answers").one()["total"]).toBe(0);
			expect(state.storage.sql.exec("SELECT yep_count FROM state").one()["yep_count"]).toBe(1);
		});
	});
});
