import {describe, expect, it} from "vitest";
import {API_ORIGIN, createBatchOverHttp, registerMachineToken, worker} from "./helpers";

describe("POST /api/v1/questions", () => {
	it("rejects requests without a machine token", async () => {
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/questions`, {
			method: "POST",
			body: JSON.stringify({project: "demo", questions: [{title: "Ship it?", body: ""}]}),
		});
		expect(response.status).toBe(401);
	});

	it("rejects unknown machine tokens", async () => {
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/questions`, {
			method: "GET",
			headers: {Authorization: "Bearer nope"},
		});
		expect(response.status).toBe(401);
	});

	it("creates a batch and assigns server-side ids", async () => {
		const token = await registerMachineToken("user-create");
		const created = await createBatchOverHttp(token, "monorepo-migration", [
			{title: "Delete the legacy build?", body: "It has been unused for a year."},
			{title: "Squash the branch?", body: ""},
		]);
		expect(created.batch_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(created.question_ids).toEqual([`${created.batch_id}:0`, `${created.batch_id}:1`]);
	});

	it("rejects a title over 100 characters", async () => {
		const token = await registerMachineToken("user-long-title");
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/questions`, {
			method: "POST",
			headers: {Authorization: `Bearer ${token}`},
			body: JSON.stringify({project: "demo", questions: [{title: "x".repeat(101), body: ""}]}),
		});
		expect(response.status).toBe(400);
	});

	it("rejects a body over 800 characters", async () => {
		const token = await registerMachineToken("user-long-body");
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/questions`, {
			method: "POST",
			headers: {Authorization: `Bearer ${token}`},
			body: JSON.stringify({project: "demo", questions: [{title: "Ship it?", body: "x".repeat(801)}]}),
		});
		expect(response.status).toBe(400);
	});

	it("rejects an empty question list", async () => {
		const token = await registerMachineToken("user-empty");
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/questions`, {
			method: "POST",
			headers: {Authorization: `Bearer ${token}`},
			body: JSON.stringify({project: "demo", questions: []}),
		});
		expect(response.status).toBe(400);
	});

	it("rejects oversized payloads on Content-Length with a bare 413", async () => {
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/questions`, {
			method: "POST",
			headers: {"Content-Length": String(1024 * 1024)},
			body: "x".repeat(1024 * 1024),
		});
		expect(response.status).toBe(413);
	});
});

describe("GET /api/v1/questions", () => {
	it("returns outstanding cards until they are answered", async () => {
		const token = await registerMachineToken("user-outstanding");
		const created = await createBatchOverHttp(token, "demo", [
			{title: "First?", body: "one"},
			{title: "Second?", body: "two"},
		]);

		const response = await worker.fetch(`${API_ORIGIN}/api/v1/questions`, {
			headers: {Authorization: `Bearer ${token}`},
		});
		expect(response.status).toBe(200);
		const listed = await response.json<{
			questions: Array<{
				batch_id: string;
				project: string;
				question_id: string;
				position: number;
				title: string;
				body: string;
				created_at: number;
			}>;
		}>();
		expect(listed.questions).toHaveLength(2);
		expect(listed.questions.map((question) => question.question_id)).toEqual(created.question_ids);
		expect(listed.questions[0]).toMatchObject({
			batch_id: created.batch_id,
			project: "demo",
			position: 0,
			title: "First?",
			body: "one",
		});
	});

	it("round-trips repo, branch, worktree, and directory to the card list", async () => {
		const token = await registerMachineToken("user-git-context");
		const created = await createBatchOverHttp(token, "demo", [{title: "Ship it?", body: ""}], {
			repo: "github.com/acme/rocket",
			branch: "migrate-build",
			worktree: "/w/rocket",
			directory: "/w/rocket/core",
		});

		const response = await worker.fetch(`${API_ORIGIN}/api/v1/questions`, {
			headers: {Authorization: `Bearer ${token}`},
		});
		expect(response.status).toBe(200);
		const listed = await response.json<{questions: unknown[]}>();
		expect(listed.questions).toEqual([
			{
				batch_id: created.batch_id,
				project: "demo",
				question_id: created.question_ids[0],
				position: 0,
				title: "Ship it?",
				body: "",
				created_at: expect.any(Number) as number,
				repo: "github.com/acme/rocket",
				branch: "migrate-build",
				worktree: "/w/rocket",
				directory: "/w/rocket/core",
			},
		]);
	});

	it("drops malformed context fields instead of rejecting the batch", async () => {
		const token = await registerMachineToken("user-oversized-context");
		const created = await createBatchOverHttp(token, "demo", [{title: "Ship it?", body: ""}], {
			branch: "migrate-build",
			directory: "/deep".repeat(60),
		});

		const response = await worker.fetch(`${API_ORIGIN}/api/v1/questions`, {
			headers: {Authorization: `Bearer ${token}`},
		});
		const listed = await response.json<{questions: unknown[]}>();
		expect(listed.questions).toEqual([
			{
				batch_id: created.batch_id,
				project: "demo",
				question_id: created.question_ids[0],
				position: 0,
				title: "Ship it?",
				body: "",
				created_at: expect.any(Number) as number,
				repo: null,
				branch: "migrate-build",
				worktree: null,
				directory: null,
			},
		]);
	});

	it("returns null context fields for batches created without git context", async () => {
		const token = await registerMachineToken("user-no-git-context");
		const created = await createBatchOverHttp(token, "demo", [{title: "Ship it?", body: ""}]);

		const response = await worker.fetch(`${API_ORIGIN}/api/v1/questions`, {
			headers: {Authorization: `Bearer ${token}`},
		});
		const listed = await response.json<{questions: unknown[]}>();
		expect(listed.questions).toEqual([
			{
				batch_id: created.batch_id,
				project: "demo",
				question_id: created.question_ids[0],
				position: 0,
				title: "Ship it?",
				body: "",
				created_at: expect.any(Number) as number,
				repo: null,
				branch: null,
				worktree: null,
				directory: null,
			},
		]);
	});

	it("keeps users isolated in separate Durable Objects", async () => {
		const tokenA = await registerMachineToken("user-a");
		const tokenB = await registerMachineToken("user-b");
		await createBatchOverHttp(tokenA, "demo", [{title: "Only for A?", body: ""}]);

		const response = await worker.fetch(`${API_ORIGIN}/api/v1/questions`, {
			headers: {Authorization: `Bearer ${tokenB}`},
		});
		const listed = await response.json<{questions: unknown[]}>();
		expect(listed.questions).toEqual([]);
	});
});
