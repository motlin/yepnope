import {runDurableObjectAlarm, runInDurableObject} from "cloudflare:test";
import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import {RETENTION_MILLISECONDS} from "../validation";
import {createBatchOverHttp, postAnswers, registerMachineToken, required} from "./helpers";

describe("7 day retention alarm", () => {
	it("arms the alarm at created_at + 7 days on batch insert", async () => {
		const userId = "retention-arm";
		const token = await registerMachineToken(userId);
		const before = Date.now();
		await createBatchOverHttp(token, "demo", [{title: "Keep?", body: ""}]);

		const stub = env.USER_DO.getByName(userId);
		await runInDurableObject(stub, async (_instance, state) => {
			const alarm = await state.storage.getAlarm();
			expect(alarm).toBeGreaterThanOrEqual(before + RETENTION_MILLISECONDS);
			expect(alarm).toBeLessThanOrEqual(Date.now() + RETENTION_MILLISECONDS);
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

			const survivorRow = state.storage.sql
				.exec("SELECT created_at FROM batches WHERE id = ?", survivor.batch_id)
				.one();
			const survivorCreatedAt = required(survivorRow["created_at"], "survivor created_at") as number;
			expect(await state.storage.getAlarm()).toBe(survivorCreatedAt + RETENTION_MILLISECONDS);
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
