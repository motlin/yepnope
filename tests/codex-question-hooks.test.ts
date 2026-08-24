import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, readdirSync, rmSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const hookPath = join(repositoryRoot, "plugins", "yepnope", "codex-hooks", "route-questions.cjs");
const scratchRoot = join(repositoryRoot, ".llm");
const routingInstruction =
	"Before asking the user any question, call ask_yep_nope first for every question that can be " +
	"answered yes or no. Do not skip YepNope because a question seems small, obvious, or inexpensive. " +
	"Use a native question only after the YepNope attempt returns afk_off or the MCP call fails. " +
	"Questions that cannot be represented truthfully as yes or no remain native.";
const nativeQuestionDenial =
	"Call ask_yep_nope before using the native user-question tool. Retry this question through YepNope " +
	"and use the native flow only if that attempt returns afk_off or fails.";
const stopContinuation =
	"The response asks the user a question without first trying ask_yep_nope. Continue the turn and " +
	"route every yes-or-no question through ask_yep_nope now. Use native text only after that attempt " +
	"returns afk_off or fails; keep input that cannot be represented truthfully as yes or no native.";

interface HookResult {
	output: unknown;
	status: number | null;
	stderr: string;
}

let pluginDataRoot: string;

beforeEach(() => {
	mkdirSync(scratchRoot, {recursive: true});
	pluginDataRoot = mkdtempSync(join(scratchRoot, "codex-question-hooks-"));
});

afterEach(() => {
	rmSync(pluginDataRoot, {recursive: true});
});

function hookInput(hookEventName: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		session_id: "session-test",
		transcript_path: "/workspace/example/transcript.jsonl",
		cwd: "/workspace/example",
		hook_event_name: hookEventName,
		model: "test-model",
		turn_id: "turn-test",
		permission_mode: "default",
		...extra,
	};
}

function runHook(input: Record<string, unknown>): HookResult {
	const result = spawnSync(process.execPath, [hookPath], {
		encoding: "utf8",
		input: JSON.stringify(input),
		env: {...process.env, PLUGIN_DATA: pluginDataRoot},
	});
	if (result.error !== undefined) {
		throw result.error;
	}
	return {
		status: result.status,
		stderr: result.stderr,
		output: result.stdout === "" ? null : (JSON.parse(result.stdout) as unknown),
	};
}

function startTurn(): HookResult {
	return runHook(hookInput("UserPromptSubmit", {prompt: "Please continue the example task."}));
}

function pluginDataFiles(): string[] {
	return readdirSync(pluginDataRoot);
}

describe("Codex question-routing hooks", () => {
	it("injects the routing rule and blocks a native question before a YepNope attempt", () => {
		expect(startTurn()).toStrictEqual({
			status: 0,
			stderr: "",
			output: {
				hookSpecificOutput: {
					hookEventName: "UserPromptSubmit",
					additionalContext: routingInstruction,
				},
			},
		});
		expect(
			runHook(hookInput("PreToolUse", {tool_name: "request_user_input", tool_use_id: "tool-100"})),
		).toStrictEqual({
			status: 0,
			stderr: "",
			output: {
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "deny",
					permissionDecisionReason: nativeQuestionDenial,
				},
			},
		});
	});

	it("allows native fallback after an AFK-off result", () => {
		startTurn();
		expect(
			runHook(
				hookInput("PreToolUse", {
					tool_name: "mcp__yepnope__ask_yep_nope",
					tool_use_id: "tool-100",
				}),
			),
		).toStrictEqual({status: 0, stderr: "", output: null});
		expect(
			runHook(
				hookInput("PostToolUse", {
					tool_name: "mcp__yepnope__ask_yep_nope",
					tool_use_id: "tool-100",
					tool_response: {
						content: [{type: "text", text: "YepNope phone routing is off."}],
						structuredContent: {route: "native", reason: "afk_off"},
					},
				}),
			),
		).toStrictEqual({status: 0, stderr: "", output: null});
		expect(runHook(hookInput("PreToolUse", {tool_name: "AskUserQuestion", tool_use_id: "tool-200"}))).toStrictEqual(
			{status: 0, stderr: "", output: null},
		);
		expect(
			runHook(hookInput("Stop", {stop_hook_active: false, last_assistant_message: "Should I continue?"})),
		).toStrictEqual({status: 0, stderr: "", output: {}});
		expect(pluginDataFiles()).toStrictEqual([]);
	});

	it("keeps native questions blocked after the user answered on YepNope", () => {
		startTurn();
		runHook(
			hookInput("PreToolUse", {
				tool_name: "mcp__yepnope__ask_yep_nope",
				tool_use_id: "tool-100",
			}),
		);
		runHook(
			hookInput("PostToolUse", {
				tool_name: "mcp__yepnope__ask_yep_nope",
				tool_use_id: "tool-100",
				tool_response: {content: [{type: "text", text: "Proceed with the example? -> YEP"}]},
			}),
		);
		expect(
			runHook(hookInput("PreToolUse", {tool_name: "request_user_input", tool_use_id: "tool-200"})),
		).toStrictEqual({
			status: 0,
			stderr: "",
			output: {
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "deny",
					permissionDecisionReason: nativeQuestionDenial,
				},
			},
		});
		expect(
			runHook(hookInput("Stop", {stop_hook_active: false, last_assistant_message: "Should I continue?"})),
		).toStrictEqual({status: 0, stderr: "", output: {decision: "block", reason: stopContinuation}});
	});

	it("permits native fallback after an MCP error", () => {
		startTurn();
		runHook(
			hookInput("PreToolUse", {
				tool_name: "mcp__yepnope__ask_yep_nope",
				tool_use_id: "tool-100",
			}),
		);
		runHook(
			hookInput("PostToolUse", {
				tool_name: "mcp__yepnope__ask_yep_nope",
				tool_use_id: "tool-100",
				tool_response: {isError: true, content: [{type: "text", text: "Connection unavailable."}]},
			}),
		);
		expect(
			runHook(hookInput("PreToolUse", {tool_name: "request_user_input", tool_use_id: "tool-200"})),
		).toStrictEqual({status: 0, stderr: "", output: null});
	});

	it("intercepts a plain-text question once without looping", () => {
		startTurn();
		expect(
			runHook(hookInput("Stop", {stop_hook_active: false, last_assistant_message: "Should I continue?"})),
		).toStrictEqual({status: 0, stderr: "", output: {decision: "block", reason: stopContinuation}});
		expect(
			runHook(hookInput("Stop", {stop_hook_active: true, last_assistant_message: "Should I continue?"})),
		).toStrictEqual({status: 0, stderr: "", output: {}});
		expect(
			runHook(
				hookInput("Stop", {
					stop_hook_active: false,
					last_assistant_message:
						"The example completed without another decision.\n\n📌 You asked: Should the example continue?",
				}),
			),
		).toStrictEqual({status: 0, stderr: "", output: {}});
		expect(pluginDataFiles()).toStrictEqual([]);
	});
});
