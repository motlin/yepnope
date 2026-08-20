import {runDurableObjectAlarm, runInDurableObject} from "cloudflare:test";
import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import {HEARTBEAT_GRACE_MILLISECONDS, RETENTION_MILLISECONDS} from "../validation";
import {API_ORIGIN, createBatchOverHttp, postAnswers, authorizeAgentClient, required, worker} from "./helpers";

describe("current deck and activity summary", () => {
	it("keeps durable outcomes consistent when current batches are answered, skipped, retracted, or expired", async () => {
		const userId = "activity-all-outcomes";
		const token = await authorizeAgentClient(userId);
		const unauthorized = await worker.fetch(`${API_ORIGIN}/api/v1/activity-summary`);
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
						worktree: null,
					},
				],
			},
			status: 200,
		});

		const summaryResponse = await worker.fetch(`${API_ORIGIN}/api/v1/activity-summary`, {
			headers: {Authorization: `Bearer ${token}`},
		});
		const body = await summaryResponse.json<{
			activity_summary: {
				total_questions: number;
				outstanding: number;
				yep: number;
				nope: number;
				skip: number;
				retracted: number;
				expired: number;
			};
		}>();
		expect({body, status: summaryResponse.status}).toStrictEqual({
			body: {
				activity_summary: {
					total_questions: 5,
					outstanding: 1,
					yep: 1,
					nope: 0,
					skip: 1,
					retracted: 1,
					expired: 1,
				},
			},
			status: 200,
		});
		const {total_questions: totalQuestions, ...outcomes} = body.activity_summary;
		expect(Object.values(outcomes).reduce((total, count) => total + count, 0)).toBe(totalQuestions);

		await runInDurableObject(stub, (_instance, state) => {
			expect(
				state.storage.sql.exec("SELECT outcome FROM question_activity ORDER BY outcome").toArray(),
			).toStrictEqual([
				{outcome: "expired"},
				{outcome: "outstanding"},
				{outcome: "retracted"},
				{outcome: "skip"},
				{outcome: "yep"},
			]);
		});
	});
});
