import {describe, expect, it} from "vitest";
import {createBatchOverHttp, postAnswers, registerMachineToken, required, worker} from "./helpers";

describe("POST /api/v1/answers", () => {
	it("records answers and removes them from the outstanding list", async () => {
		const token = await registerMachineToken("user-answers");
		const created = await createBatchOverHttp(token, "demo", [
			{title: "First?", body: ""},
			{title: "Second?", body: ""},
		]);
		const firstQuestionId = required(created.question_ids[0], "first question id");
		const secondQuestionId = required(created.question_ids[1], "second question id");

		const response = await postAnswers(token, [
			{question_id: firstQuestionId, disposition: "yep"},
			{question_id: secondQuestionId, disposition: "skip"},
		]);
		expect(response.status).toBe(200);

		const outstanding = await worker.fetch("https://yepnope.app/api/v1/questions", {
			headers: {Authorization: `Bearer ${token}`},
		});
		const listed = await outstanding.json<{questions: unknown[]}>();
		expect(listed.questions).toEqual([]);
	});

	it("rejects an unknown question id with 404", async () => {
		const token = await registerMachineToken("user-unknown-question");
		const response = await postAnswers(token, [{question_id: crypto.randomUUID(), disposition: "yep"}]);
		expect(response.status).toBe(404);
	});

	it("rejects answering the same question twice with 409", async () => {
		const token = await registerMachineToken("user-double-answer");
		const created = await createBatchOverHttp(token, "demo", [{title: "Once?", body: ""}]);
		const questionId = required(created.question_ids[0], "question id");

		expect((await postAnswers(token, [{question_id: questionId, disposition: "nope"}])).status).toBe(200);
		expect((await postAnswers(token, [{question_id: questionId, disposition: "yep"}])).status).toBe(409);
	});

	it("rejects a disposition outside yep/nope/skip", async () => {
		const token = await registerMachineToken("user-bad-disposition");
		const created = await createBatchOverHttp(token, "demo", [{title: "Maybe?", body: ""}]);
		const questionId = required(created.question_ids[0], "question id");
		const response = await postAnswers(token, [{question_id: questionId, disposition: "maybe"}]);
		expect(response.status).toBe(400);
	});

	it("cannot answer another user's questions", async () => {
		const tokenA = await registerMachineToken("answer-user-a");
		const tokenB = await registerMachineToken("answer-user-b");
		const created = await createBatchOverHttp(tokenA, "demo", [{title: "Mine?", body: ""}]);
		const questionId = required(created.question_ids[0], "question id");

		const response = await postAnswers(tokenB, [{question_id: questionId, disposition: "yep"}]);
		expect(response.status).toBe(404);
	});
});
