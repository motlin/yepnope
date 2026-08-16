import {describe, expect, it} from "vitest";
import {API_ORIGIN, createBatchOverHttp, postAnswers, registerMachineToken, required, worker} from "./helpers";

async function getAfk(token: string): Promise<{status: number; afk?: boolean}> {
	const response = await worker.fetch(`${API_ORIGIN}/api/v1/afk`, {
		headers: {Authorization: `Bearer ${token}`},
	});
	if (response.status !== 200) {
		return {status: response.status};
	}
	const body = (await response.json()) as {afk: boolean};
	return {status: response.status, afk: body.afk};
}

async function putAfk(token: string, afk: boolean): Promise<Response> {
	return worker.fetch(`${API_ORIGIN}/api/v1/afk`, {
		method: "PUT",
		headers: {Authorization: `Bearer ${token}`},
		body: JSON.stringify({afk}),
	});
}

describe("AFK mode", () => {
	it("defaults to on", async () => {
		const token = await registerMachineToken("afk-default");
		expect(await getAfk(token)).toEqual({status: 200, afk: true});
	});

	it("requires auth", async () => {
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/afk`);
		expect(response.status).toBe(401);
	});

	it("flips off and back on", async () => {
		const token = await registerMachineToken("afk-flip");
		const offResponse = await putAfk(token, false);
		expect(offResponse.status).toBe(200);
		expect(await offResponse.json()).toEqual({afk: false});
		expect(await getAfk(token)).toEqual({status: 200, afk: false});

		const onResponse = await putAfk(token, true);
		expect(onResponse.status).toBe(200);
		expect(await getAfk(token)).toEqual({status: 200, afk: true});
	});

	it("rejects a malformed body", async () => {
		const token = await registerMachineToken("afk-bad-body");
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/afk`, {
			method: "PUT",
			headers: {Authorization: `Bearer ${token}`},
			body: JSON.stringify({afk: "sideways"}),
		});
		expect(response.status).toBe(400);
	});

	it("rejects new batches while off, teaching the model to use AskUserQuestion", async () => {
		const token = await registerMachineToken("afk-gate");
		await putAfk(token, false);
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/questions`, {
			method: "POST",
			headers: {Authorization: `Bearer ${token}`},
			body: JSON.stringify({project: "demo", questions: [{title: "Ship?", body: ""}]}),
		});
		expect(response.status).toBe(409);
		const body = (await response.json()) as {error: string; message: string};
		expect(body.error).toBe("afk_off");
		expect(body.message).toContain("AskUserQuestion");
	});

	it("leaves pending cards answerable after flipping off", async () => {
		const token = await registerMachineToken("afk-pending");
		const created = await createBatchOverHttp(token, "demo", [{title: "Still here?", body: ""}]);
		const questionId = required(created.question_ids[0], "question id");
		await putAfk(token, false);

		const listResponse = await worker.fetch(`${API_ORIGIN}/api/v1/questions`, {
			headers: {Authorization: `Bearer ${token}`},
		});
		const listed = (await listResponse.json()) as {questions: Array<{question_id: string}>};
		expect(listed.questions.map((question) => question.question_id)).toEqual([questionId]);

		const answered = await postAnswers(token, [{question_id: questionId, disposition: "yep"}]);
		expect(answered.status).toBe(200);
	});
});
