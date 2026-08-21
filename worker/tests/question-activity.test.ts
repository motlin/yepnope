import {runDurableObjectAlarm, runInDurableObject} from "cloudflare:test";
import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import {HEARTBEAT_GRACE_MILLISECONDS, RETENTION_MILLISECONDS} from "../validation";
import {
	API_ORIGIN,
	authorizeAgentClient,
	createBatchOverHttp,
	postAnswers,
	questionOutcomes,
	required,
	worker,
} from "./helpers";

describe("current deck and durable question activity", () => {
	it("keeps durable outcomes consistent when current batches are answered, skipped, retracted, or expired", async () => {
		const userId = "activity-all-outcomes";
		const token = await authorizeAgentClient(userId);
		const unauthorized = await worker.fetch(`${API_ORIGIN}/api/v1/current-deck`);
		expect({body: await unauthorized.text(), status: unauthorized.status}).toStrictEqual({body: "", status: 401});
		const answered = await createBatchOverHttp(token, "answered", [{title: "Approve?", body: ""}]);
		const skipped = await createBatchOverHttp(token, "skipped", [{title: "Decide later?", body: ""}]);
		const retracted = await createBatchOverHttp(token, "retracted", [{title: "Still connected?", body: ""}]);
		const expired = await createBatchOverHttp(token, "expired", [{title: "Too old?", body: ""}]);
		const outstanding = await createBatchOverHttp(token, "outstanding", [{title: "Answer this?", body: ""}]);

		await postAnswers(token, [
			{question_id: required(answered.question_ids[0], "answered question id"), disposition: "yep"},
		]);
		await postAnswers(token, [
			{question_id: required(skipped.question_ids[0], "skipped question id"), disposition: "skip"},
		]);

		const stub = env.USER_DO.getByName(userId);
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE batches SET last_heartbeat_at = last_heartbeat_at - ? WHERE id = ?",
				HEARTBEAT_GRACE_MILLISECONDS + 60_000,
				retracted.batch_id,
			);
			state.storage.sql.exec(
				"UPDATE batches SET created_at = created_at - ? WHERE id = ?",
				RETENTION_MILLISECONDS + 60_000,
				expired.batch_id,
			);
		});
		expect(await runDurableObjectAlarm(stub)).toBe(true);

		const deckResponse = await worker.fetch(`${API_ORIGIN}/api/v1/current-deck`, {
			headers: {Authorization: `Bearer ${token}`},
		});
		expect({body: await deckResponse.json(), status: deckResponse.status}).toStrictEqual({
			body: {
				current_deck: [
					{
						batch_id: outstanding.batch_id,
						body: "",
						branch: null,
						created_at: expect.any(Number) as number,
						directory: null,
						position: 0,
						project: "outstanding",
						question_id: outstanding.question_ids[0],
						repo: null,
						title: "Answer this?",
					},
				],
			},
			status: 200,
		});

		// 🧾 One row per question asked, and the deck above is the "outstanding" one. Answering,
		// skipping, retracting, and expiring each leave their own mark and none of them lose a row.
		expect(await questionOutcomes(userId)).toStrictEqual(["expired", "outstanding", "retracted", "skip", "yep"]);
	});
});
