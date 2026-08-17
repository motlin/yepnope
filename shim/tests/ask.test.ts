import {errorFrame, resolvedFrame, stateFrame} from "../../worker/protocol";
import {QUOTA_EXHAUSTED_TEXT, SKIP_INSTRUCTION, askYepNope} from "../ask";
import {startMockBackend, type MockBackend} from "./mock-backend";

const CONTEXT = {repo: "github.com/acme/rocket", branch: "main", worktree: "/w", directory: "/w/core"};

const TWO_QUESTIONS = {
	project: "platform-upgrades",
	questions: [
		{title: "Bump Guava to 33.4 across the monorepo?", body: "12 modules recompile."},
		{title: "Delete the TSLogger compatibility shim?", body: "No call sites left."},
	],
};

function fastOptions(backend: MockBackend) {
	return {
		baseUrl: backend.baseUrl,
		token: "ynp_test",
		heartbeatMilliseconds: 10,
		progressMilliseconds: 10,
		reconnectDelayMilliseconds: 10,
	};
}

describe("askYepNope", () => {
	let backend: MockBackend | undefined;

	afterEach(async () => {
		await backend?.close();
		backend = undefined;
	});

	it("rejects over-length questions locally with the teaching message", async () => {
		backend = await startMockBackend();
		const outcome = await askYepNope(
			{project: "p", questions: [{title: "x".repeat(101), body: "b"}]},
			CONTEXT,
			fastOptions(backend),
		);
		expect(outcome.isError).toBe(true);
		expect(outcome.text).toContain("questions[0].title is 101 characters; the limit is 100.");
		expect(outcome.text).toContain("Rewrite the over-length questions shorter and resend the whole batch");
		expect(backend.batchBodies).toEqual([]);
	});

	it("surfaces the AFK-off teaching error verbatim", async () => {
		const message =
			"The user is at their keyboard, so questions are not being routed to their phone. " +
			"Use the AskUserQuestion tool instead of ask_yep_nope for this question.";
		backend = await startMockBackend({createStatus: 409, createBody: {error: "afk_off", message}});
		const outcome = await askYepNope(TWO_QUESTIONS, CONTEXT, fastOptions(backend));
		expect(outcome.isError).toBe(true);
		expect(outcome.text).toBe(message);
	});

	it("posts the batch with git context and blocks until every question is dispositioned", async () => {
		backend = await startMockBackend({
			onConnection(socket) {
				socket.send(stateFrame("bat_1", {"bat_1:0": null, "bat_1:1": null}));
				setTimeout(() => {
					socket.send(stateFrame("bat_1", {"bat_1:0": "yep", "bat_1:1": null}));
					socket.send(resolvedFrame("bat_1", {"bat_1:0": "yep", "bat_1:1": "skip"}));
				}, 50);
			},
		});
		const progressMessages: string[] = [];
		const outcome = await askYepNope(TWO_QUESTIONS, CONTEXT, {
			...fastOptions(backend),
			onProgress: (message) => progressMessages.push(message),
		});
		expect(outcome.isError).toBe(false);
		expect(outcome.text).toBe(
			"Bump Guava to 33.4 across the monorepo? -> YEP\n" +
				`Delete the TSLogger compatibility shim? -> ${SKIP_INSTRUCTION}`,
		);
		expect(outcome.dispositions).toEqual(["yep", "skip"]);
		expect(backend.batchBodies).toEqual([
			{
				project: "platform-upgrades",
				repo: "github.com/acme/rocket",
				branch: "main",
				worktree: "/w",
				directory: "/w/core",
				questions: TWO_QUESTIONS.questions,
			},
		]);
		expect(backend.authorizationHeaders).toEqual(["Bearer ynp_test"]);
		expect(backend.heartbeats.length).toBeGreaterThan(0);
		expect(JSON.parse(backend.heartbeats[0] ?? "")).toEqual({type: "heartbeat"});
		expect(progressMessages.length).toBeGreaterThan(0);
	});

	it("maps a nope to NOPE", async () => {
		backend = await startMockBackend({
			onConnection(socket) {
				socket.send(resolvedFrame("bat_1", {"bat_1:0": "nope", "bat_1:1": "yep"}));
			},
		});
		const outcome = await askYepNope(TWO_QUESTIONS, CONTEXT, fastOptions(backend));
		expect(outcome.isError).toBe(false);
		expect(outcome.text).toBe(
			"Bump Guava to 33.4 across the monorepo? -> NOPE\n" + "Delete the TSLogger compatibility shim? -> YEP",
		);
	});

	it("returns the STOP wording as an error when quota is exhausted", async () => {
		backend = await startMockBackend({
			onConnection(socket) {
				socket.send(
					errorFrame("bat_1", {"bat_1:0": null, "bat_1:1": null}, "quota_exhausted", "quota exhausted"),
				);
			},
		});
		const outcome = await askYepNope(TWO_QUESTIONS, CONTEXT, fastOptions(backend));
		expect(outcome.isError).toBe(true);
		expect(outcome.text).toBe(QUOTA_EXHAUSTED_TEXT);
	});

	it("surfaces other error frames as tool errors", async () => {
		backend = await startMockBackend({
			onConnection(socket) {
				socket.send(
					errorFrame(
						"bat_1",
						{"bat_1:0": "yep", "bat_1:1": null},
						"batch_expired",
						"this batch passed the 7 day retention limit",
					),
				);
			},
		});
		const outcome = await askYepNope(TWO_QUESTIONS, CONTEXT, fastOptions(backend));
		expect(outcome.isError).toBe(true);
		expect(outcome.text).toBe("this batch passed the 7 day retention limit");
	});

	it("reconnects after a dropped socket and still returns the answers", async () => {
		let connectionCount = 0;
		backend = await startMockBackend({
			onConnection(socket) {
				connectionCount += 1;
				if (connectionCount === 1) {
					socket.send(stateFrame("bat_1", {"bat_1:0": null, "bat_1:1": null}));
					socket.close();
					return;
				}
				socket.send(resolvedFrame("bat_1", {"bat_1:0": "yep", "bat_1:1": "yep"}));
			},
		});
		const outcome = await askYepNope(TWO_QUESTIONS, CONTEXT, fastOptions(backend));
		expect(outcome.isError).toBe(false);
		expect(connectionCount).toBe(2);
		expect(outcome.dispositions).toEqual(["yep", "yep"]);
	});

	it("omits git fields that could not be derived", async () => {
		backend = await startMockBackend({
			onConnection(socket) {
				socket.send(resolvedFrame("bat_1", {"bat_1:0": "yep", "bat_1:1": "yep"}));
			},
		});
		await askYepNope(
			TWO_QUESTIONS,
			{repo: null, branch: null, worktree: null, directory: "/somewhere"},
			fastOptions(backend),
		);
		expect(backend.batchBodies).toEqual([
			{project: "platform-upgrades", directory: "/somewhere", questions: TWO_QUESTIONS.questions},
		]);
	});
});
