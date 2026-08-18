import {describe, expect, it} from "vitest";
import {API_ORIGIN, postAnswers, registerMachineToken, worker} from "./helpers";

async function postHook(token: string, payload: unknown): Promise<Response> {
	return worker.fetch(`${API_ORIGIN}/api/v1/hook`, {
		method: "POST",
		headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
		body: JSON.stringify(payload),
	});
}

async function setAfk(token: string, afk: boolean): Promise<void> {
	const response = await worker.fetch(`${API_ORIGIN}/api/v1/afk`, {
		method: "PUT",
		headers: {Authorization: `Bearer ${token}`},
		body: JSON.stringify({afk}),
	});
	if (response.status !== 200) {
		throw new Error(`expected 200, got ${response.status}`);
	}
}

interface ListedQuestion {
	question_id: string;
	title: string;
	body: string;
	project: string;
}

async function listQuestions(token: string): Promise<ListedQuestion[]> {
	const response = await worker.fetch(`${API_ORIGIN}/api/v1/current-deck`, {
		headers: {Authorization: `Bearer ${token}`},
	});
	const body = await response.json<{current_deck: ListedQuestion[]}>();
	return body.current_deck;
}

async function waitForQuestion(token: string): Promise<ListedQuestion> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const questions = await listQuestions(token);
		const first = questions[0];
		if (first !== undefined) {
			return first;
		}
		await new Promise((resolve) => {
			setTimeout(resolve, 10);
		});
	}
	throw new Error("no question appeared");
}

function permissionRequestPayload(toolInput: unknown): Record<string, unknown> {
	return {
		session_id: "s1",
		transcript_path: "/tmp/t.jsonl",
		cwd: "/Users/craig/projects/yepnope",
		hook_event_name: "PermissionRequest",
		tool_name: "Bash",
		tool_input: toolInput,
	};
}

describe("POST /api/v1/hook", () => {
	it("requires auth", async () => {
		const response = await worker.fetch(`${API_ORIGIN}/api/v1/hook`, {
			method: "POST",
			body: JSON.stringify(permissionRequestPayload({command: "ls"})),
		});
		expect(response.status).toBe(401);
	});

	it("rejects a malformed payload", async () => {
		const token = await registerMachineToken("hook-bad-payload");
		const response = await postHook(token, {nope: true});
		expect(response.status).toBe(400);
	});

	it("abstains from unknown hook events", async () => {
		const token = await registerMachineToken("hook-unknown-event");
		const response = await postHook(token, {hook_event_name: "SessionStart"});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({});
	});

	describe("PreToolUse", () => {
		it("denies AskUserQuestion with a redirect reason while AFK", async () => {
			const token = await registerMachineToken("hook-pretooluse-deny");
			const response = await postHook(token, {
				hook_event_name: "PreToolUse",
				tool_name: "AskUserQuestion",
				tool_input: {questions: []},
			});
			expect(response.status).toBe(200);
			const body = await response.json<{
				hookSpecificOutput: {
					hookEventName: string;
					permissionDecision: string;
					permissionDecisionReason: string;
				};
			}>();
			expect(body.hookSpecificOutput.hookEventName).toBe("PreToolUse");
			expect(body.hookSpecificOutput.permissionDecision).toBe("deny");
			expect(body.hookSpecificOutput.permissionDecisionReason).toContain("ask_yep_nope");
			expect(body.hookSpecificOutput.permissionDecisionReason).toContain("proceed with");
		});

		it("abstains for AskUserQuestion when AFK is off", async () => {
			const token = await registerMachineToken("hook-pretooluse-off");
			await setAfk(token, false);
			const response = await postHook(token, {
				hook_event_name: "PreToolUse",
				tool_name: "AskUserQuestion",
				tool_input: {questions: []},
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({});
		});

		it("abstains for other tools even while AFK", async () => {
			const token = await registerMachineToken("hook-pretooluse-other");
			const response = await postHook(token, {
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: {command: "ls"},
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({});
		});
	});

	describe("PermissionRequest", () => {
		it("returns no decision without creating a card when AFK is off", async () => {
			const token = await registerMachineToken("hook-permission-off");
			await setAfk(token, false);
			const response = await postHook(token, permissionRequestPayload({command: "npx wrangler deploy"}));
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({});
			expect(await listQuestions(token)).toEqual([]);
		});

		it("routes to a card and allows on yep", async () => {
			const token = await registerMachineToken("hook-permission-yep");
			const hookResponse = postHook(
				token,
				permissionRequestPayload({command: "npx wrangler deploy", description: "Deploy the worker"}),
			);
			const question = await waitForQuestion(token);
			expect(question.project).toBe("yepnope");
			expect(question.title).toBe("Allow Bash: npx wrangler deploy?");
			await postAnswers(token, [{question_id: question.question_id, disposition: "yep"}]);
			const response = await hookResponse;
			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body).toEqual({
				hookSpecificOutput: {hookEventName: "PermissionRequest", decision: {behavior: "allow"}},
			});
		});

		it("denies on nope", async () => {
			const token = await registerMachineToken("hook-permission-nope");
			const hookResponse = postHook(token, permissionRequestPayload({command: "rm -rf /"}));
			const question = await waitForQuestion(token);
			await postAnswers(token, [{question_id: question.question_id, disposition: "nope"}]);
			const response = await hookResponse;
			expect(response.status).toBe(200);
			const body = await response.json<{
				hookSpecificOutput: {decision: {behavior: string; message: string}};
			}>();
			expect(body.hookSpecificOutput.decision.behavior).toBe("deny");
			expect(body.hookSpecificOutput.decision.message).toContain("denied");
		});

		it("returns no decision on skip so the native prompt takes over", async () => {
			const token = await registerMachineToken("hook-permission-skip");
			const hookResponse = postHook(token, permissionRequestPayload({command: "ls"}));
			const question = await waitForQuestion(token);
			await postAnswers(token, [{question_id: question.question_id, disposition: "skip"}]);
			const response = await hookResponse;
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({});
		});

		it("accepts an oversized tool_input and truncates it into the card", async () => {
			const token = await registerMachineToken("hook-permission-huge");
			const hookResponse = postHook(token, permissionRequestPayload({command: "x".repeat(400_000)}));
			const question = await waitForQuestion(token);
			expect(question.title.length).toBeLessThanOrEqual(100);
			expect(question.body.length).toBeLessThanOrEqual(800);
			await postAnswers(token, [{question_id: question.question_id, disposition: "yep"}]);
			expect((await hookResponse).status).toBe(200);
		});
	});
});
