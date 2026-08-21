import {runInDurableObject} from "cloudflare:test";
import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import {
	API_ORIGIN,
	createBatchOverHttp,
	createVerifiedBrowserSession,
	nextMessage,
	authorizeAgentClient,
	required,
	worker,
} from "./helpers";

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
		const token = await authorizeAgentClient("user-create");
		const created = await createBatchOverHttp(token, "monorepo-migration", [
			{title: "Delete the legacy build?", body: "It has been unused for a year."},
			{title: "Squash the branch?", body: ""},
		]);
		expect(created.batch_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(created.question_ids).toStrictEqual([`${created.batch_id}:0`, `${created.batch_id}:1`]);
	});

	it("rolls back the batch and current questions when activity bookkeeping fails", async () => {
		const userId = "user-atomic-batch";
		const stub = env.USER_DO.getByName(userId);
		await stub.getAfk(false);

		await runInDurableObject(stub, async (instance, state) => {
			state.storage.sql.exec(`
				CREATE TRIGGER reject_question_activity
				BEFORE INSERT ON question_activity
				BEGIN
					SELECT RAISE(ABORT, 'test activity failure');
				END
			`);

			await expect(
				instance.createBatch({project: "atomic-test", questions: [{title: "Ship it?", body: ""}]}),
			).rejects.toThrow("test activity failure");

			expect({
				batches: state.storage.sql.exec("SELECT COUNT(*) AS total FROM batches").one()["total"],
				questions: state.storage.sql.exec("SELECT COUNT(*) AS total FROM questions").one()["total"],
				activity: state.storage.sql.exec("SELECT COUNT(*) AS total FROM question_activity").one()["total"],
				alarm: await state.storage.getAlarm(),
			}).toStrictEqual({batches: 0, questions: 0, activity: 0, alarm: null});
		});
	});

	it("rejects a title over 100 characters", async () => {
		const token = await authorizeAgentClient("user-long-title");
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/questions`, {
			method: "POST",
			headers: {Authorization: `Bearer ${token}`},
			body: JSON.stringify({project: "demo", questions: [{title: "x".repeat(101), body: ""}]}),
		});
		expect(response.status).toBe(400);
	});

	it("rejects a body over 800 characters", async () => {
		const token = await authorizeAgentClient("user-long-body");
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/questions`, {
			method: "POST",
			headers: {Authorization: `Bearer ${token}`},
			body: JSON.stringify({project: "demo", questions: [{title: "Ship it?", body: "x".repeat(801)}]}),
		});
		expect(response.status).toBe(400);
	});

	it("rejects an empty question list", async () => {
		const token = await authorizeAgentClient("user-empty");
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

describe("GET /api/v1/current-deck", () => {
	it("returns outstanding cards until they are answered", async () => {
		const token = await authorizeAgentClient("user-outstanding");
		const created = await createBatchOverHttp(token, "demo", [
			{title: "First?", body: "one"},
			{title: "Second?", body: "two"},
		]);

		const response = await worker.fetch(`${API_ORIGIN}/api/v1/current-deck`, {
			headers: {Authorization: `Bearer ${token}`},
		});
		expect(response.status).toBe(200);
		const listed = await response.json<{
			current_deck: Array<{
				batch_id: string;
				project: string;
				question_id: string;
				position: number;
				title: string;
				body: string;
				created_at: number;
			}>;
		}>();
		expect(listed).toStrictEqual({
			current_deck: [
				{
					batch_id: created.batch_id,
					body: "one",
					branch: null,
					created_at: expect.any(Number) as number,
					directory: null,
					position: 0,
					project: "demo",
					question_id: created.question_ids[0],
					repo: null,
					title: "First?",
				},
				{
					batch_id: created.batch_id,
					body: "two",
					branch: null,
					created_at: expect.any(Number) as number,
					directory: null,
					position: 1,
					project: "demo",
					question_id: created.question_ids[1],
					repo: null,
					title: "Second?",
				},
			],
		});
	});

	it("round-trips repo, branch, and directory to the card list", async () => {
		const token = await authorizeAgentClient("user-git-context");
		const created = await createBatchOverHttp(token, "demo", [{title: "Ship it?", body: ""}], {
			repo: "github.com/acme/rocket",
			branch: "migrate-build",
			directory: "/w/rocket/core",
		});

		const response = await worker.fetch(`${API_ORIGIN}/api/v1/current-deck`, {
			headers: {Authorization: `Bearer ${token}`},
		});
		expect(response.status).toBe(200);
		const listed = await response.json<{current_deck: unknown[]}>();
		expect(listed.current_deck).toStrictEqual([
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
				directory: "/w/rocket/core",
			},
		]);
	});

	it("drops malformed context fields instead of rejecting the batch", async () => {
		const token = await authorizeAgentClient("user-oversized-context");
		const created = await createBatchOverHttp(token, "demo", [{title: "Ship it?", body: ""}], {
			branch: "migrate-build",
			directory: "/deep".repeat(60),
		});

		const response = await worker.fetch(`${API_ORIGIN}/api/v1/current-deck`, {
			headers: {Authorization: `Bearer ${token}`},
		});
		const listed = await response.json<{current_deck: unknown[]}>();
		expect(listed.current_deck).toStrictEqual([
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
				directory: null,
			},
		]);
	});

	it("returns null context fields for batches created without git context", async () => {
		const token = await authorizeAgentClient("user-no-git-context");
		const created = await createBatchOverHttp(token, "demo", [{title: "Ship it?", body: ""}]);

		const response = await worker.fetch(`${API_ORIGIN}/api/v1/current-deck`, {
			headers: {Authorization: `Bearer ${token}`},
		});
		const listed = await response.json<{current_deck: unknown[]}>();
		expect(listed.current_deck).toStrictEqual([
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
				directory: null,
			},
		]);
	});

	it("keeps users isolated in separate Durable Objects", async () => {
		const tokenA = await authorizeAgentClient("user-a");
		const tokenB = await authorizeAgentClient("user-b");
		await createBatchOverHttp(tokenA, "demo", [{title: "Only for A?", body: ""}]);

		const response = await worker.fetch(`${API_ORIGIN}/api/v1/current-deck`, {
			headers: {Authorization: `Bearer ${tokenB}`},
		});
		const listed = await response.json<{current_deck: unknown[]}>();
		expect(listed.current_deck).toStrictEqual([]);
	});
});

describe("GET /api/v1/current-deck/stream", () => {
	it("rejects obsolete bearer credentials in WebSocket subprotocols", async () => {
		const token = await authorizeAgentClient("user-obsolete-websocket-subprotocol");
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/current-deck/stream`, {
			headers: {"Sec-WebSocket-Protocol": `yepnope, ${token}`, Upgrade: "websocket"},
		});

		expect({protocol: response.headers.get("Sec-WebSocket-Protocol"), status: response.status}).toStrictEqual({
			protocol: null,
			status: 401,
		});
	});

	it("starts with the complete outstanding card state and broadcasts each replacement", async () => {
		const session = await createVerifiedBrowserSession();
		const token = await authorizeAgentClient(session.userId);
		const created = await createBatchOverHttp(token, "demo", [
			{title: "First?", body: "one"},
			{title: "Second?", body: "two"},
		]);
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/current-deck/stream`, {
			headers: {Cookie: session.cookie, Upgrade: "websocket"},
		});
		expect(response.status).toBe(101);
		expect(response.headers.get("Sec-WebSocket-Protocol")).toBeNull();
		const socket = required(response.webSocket ?? undefined, "websocket on the upgrade response");
		const initialMessage = nextMessage(socket);
		socket.accept();

		expect(JSON.parse(await initialMessage)).toStrictEqual({
			type: "current_deck",
			afk: true,
			connected_mcp_client_count: 1,
			current_deck: [
				{
					batch_id: created.batch_id,
					project: "demo",
					repo: null,
					branch: null,
					directory: null,
					question_id: created.question_ids[0],
					position: 0,
					title: "First?",
					body: "one",
					created_at: expect.any(Number) as number,
				},
				{
					batch_id: created.batch_id,
					project: "demo",
					repo: null,
					branch: null,
					directory: null,
					question_id: created.question_ids[1],
					position: 1,
					title: "Second?",
					body: "two",
					created_at: expect.any(Number) as number,
				},
			],
		});

		const replacementMessage = nextMessage(socket);
		await worker.fetch(`${API_ORIGIN}/api/v1/answers`, {
			method: "POST",
			headers: {Authorization: `Bearer ${token}`},
			body: JSON.stringify({answers: [{question_id: created.question_ids[0], disposition: "yep"}]}),
		});
		expect(JSON.parse(await replacementMessage)).toStrictEqual({
			type: "current_deck",
			afk: true,
			connected_mcp_client_count: 1,
			current_deck: [
				{
					batch_id: created.batch_id,
					project: "demo",
					repo: null,
					branch: null,
					directory: null,
					question_id: created.question_ids[1],
					position: 1,
					title: "Second?",
					body: "two",
					created_at: expect.any(Number) as number,
				},
			],
		});
		socket.close();
	});
});
