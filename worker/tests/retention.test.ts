import {runDurableObjectAlarm, runInDurableObject} from "cloudflare:test";
import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
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

describe("7 day retention alarm", () => {
	it("sends the batch identifier and final dispositions before expiry deletion", async () => {
		const userId = "retention-expiry-frame";
		const token = await registerMachineToken(userId);
		const created = await createBatchOverHttp(token, "demo", [
			{title: "First?", body: ""},
			{title: "Second?", body: ""},
		]);
		const firstQuestionId = required(created.question_ids[0], "first question id");
		const secondQuestionId = required(created.question_ids[1], "second question id");
		await postAnswers(token, [{question_id: firstQuestionId, disposition: "yep"}]);
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/questions/${created.batch_id}/stream`, {
			headers: {Authorization: `Bearer ${token}`, Upgrade: "websocket"},
		});
		const socket = required(response.webSocket ?? undefined, "websocket on the upgrade response");
		const initialMessage = nextMessage(socket);
		socket.accept();
		await initialMessage;

		const stub = env.USER_DO.getByName(userId);
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("UPDATE batches SET created_at = created_at - ?", RETENTION_MILLISECONDS + 60_000);
		});
		const expiredMessage = nextMessage(socket);
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(JSON.parse(await expiredMessage)).toStrictEqual({
			type: "error",
			batch_id: created.batch_id,
			dispositions: {
				[firstQuestionId]: "yep",
				[secondQuestionId]: null,
			},
			code: "batch_expired",
			message: "this batch passed the 7 day retention limit",
		});
	});

	it("keeps the earlier alarm when a second batch arrives", async () => {
		const userId = "retention-earliest";
		const token = await registerMachineToken(userId);
		await createBatchOverHttp(token, "demo", [{title: "First?", body: ""}]);

		const stub = env.USER_DO.getByName(userId);
		const firstAlarm = await runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm());
		await createBatchOverHttp(token, "demo", [{title: "Second?", body: ""}]);
		const secondAlarm = await runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm());
		expect(secondAlarm).toBe(firstAlarm);
	});

	it("purges batches older than 7 days and re-arms for the survivor", async () => {
		const userId = "retention-purge";
		const token = await registerMachineToken(userId);
		const expired = await createBatchOverHttp(token, "demo", [{title: "Old?", body: ""}]);
		const survivor = await createBatchOverHttp(token, "demo", [{title: "Fresh?", body: ""}]);

		const stub = env.USER_DO.getByName(userId);
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE batches SET created_at = created_at - ? WHERE id = ?",
				RETENTION_MILLISECONDS + 60_000,
				expired.batch_id,
			);
		});

		expect(await runDurableObjectAlarm(stub)).toBe(true);

		await runInDurableObject(stub, async (_instance, state) => {
			const batchIds = state.storage.sql
				.exec("SELECT id FROM batches")
				.toArray()
				.map((row) => row["id"]);
			expect(batchIds).toEqual([survivor.batch_id]);

			const questionCount = state.storage.sql
				.exec("SELECT COUNT(*) AS total FROM questions WHERE batch_id = ?", expired.batch_id)
				.one();
			expect(questionCount["total"]).toBe(0);

			// 💓 The survivor is unresolved, so its heartbeat grace deadline precedes retention.
			const survivorRow = state.storage.sql
				.exec("SELECT last_heartbeat_at FROM batches WHERE id = ?", survivor.batch_id)
				.one();
			const survivorHeartbeatAt = required(
				survivorRow["last_heartbeat_at"],
				"survivor last_heartbeat_at",
			) as number;
			expect(await state.storage.getAlarm()).toBe(survivorHeartbeatAt + HEARTBEAT_GRACE_MILLISECONDS);
		});
	});

	it("purges answers with their batch and leaves counters alone", async () => {
		const userId = "retention-counters";
		const token = await registerMachineToken(userId);
		const created = await createBatchOverHttp(token, "demo", [{title: "Old?", body: ""}]);
		const questionId = required(created.question_ids[0], "question id");
		await postAnswers(token, [{question_id: questionId, disposition: "yep"}]);

		const stub = env.USER_DO.getByName(userId);
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("UPDATE batches SET created_at = created_at - ?", RETENTION_MILLISECONDS + 60_000);
		});
		expect(await runDurableObjectAlarm(stub)).toBe(true);

		await runInDurableObject(stub, async (_instance, state) => {
			expect(state.storage.sql.exec("SELECT COUNT(*) AS total FROM answers").one()["total"]).toBe(0);
			expect(state.storage.sql.exec("SELECT yep_count FROM state").one()["yep_count"]).toBe(1);
			expect(await state.storage.getAlarm()).toBeNull();
		});
	});
});
