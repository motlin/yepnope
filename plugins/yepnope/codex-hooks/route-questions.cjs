#!/usr/bin/env node

"use strict";

const {createHash} = require("node:crypto");
const {mkdirSync, readFileSync, rmSync, writeFileSync} = require("node:fs");
const {join} = require("node:path");

const ROUTING_INSTRUCTION =
	"Before asking the user any question, call ask_yep_nope first for every question that can be " +
	"answered yes or no. Do not skip YepNope because a question seems small, obvious, or inexpensive. " +
	"Use a native question only after the YepNope attempt returns afk_off or the MCP call fails. " +
	"Questions that cannot be represented truthfully as yes or no remain native. The phone receives " +
	"only the title, body, and context chips passed to ask_yep_nope, never console or chat text. Copy " +
	"every exact decision item and the consequence of Yes into the card body. Never substitute 'listed " +
	"above', 'as discussed', 'these commits', or 'previous message' for the details. For commit approval, " +
	"include each short SHA and subject.";

const NATIVE_QUESTION_DENIAL =
	"Call ask_yep_nope before using the native user-question tool. Retry this question through YepNope " +
	"with all decision context copied into the phone-visible title and body. The phone cannot see console " +
	"or chat text. Use the native flow only if that attempt returns afk_off or fails.";

const STOP_CONTINUATION =
	"The response asks the user a question without first trying ask_yep_nope. Continue the turn and " +
	"route every yes-or-no question through ask_yep_nope now. Copy all decision context into the " +
	"phone-visible title and body because the phone cannot see console or chat text. Use native text only " +
	"after that attempt returns afk_off or fails; keep input that cannot be represented truthfully as yes " +
	"or no native.";

const OUTCOMES = new Set(["not_attempted", "pending", "fallback", "answered"]);

function record(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`);
	}
	return value;
}

function stringField(value, field) {
	const fieldValue = value[field];
	if (typeof fieldValue !== "string" || fieldValue.length === 0) {
		throw new TypeError(`${field} must be a non-empty string`);
	}
	return fieldValue;
}

function parseInput() {
	const input = record(JSON.parse(readFileSync(0, "utf8")), "hook input");
	stringField(input, "hook_event_name");
	stringField(input, "session_id");
	stringField(input, "turn_id");
	return input;
}

function pluginDataRoot() {
	const root = process.env.PLUGIN_DATA;
	if (root === undefined || root.length === 0) {
		throw new Error("PLUGIN_DATA is required");
	}
	mkdirSync(root, {recursive: true, mode: 0o700});
	return root;
}

function statePath(input) {
	const key = createHash("sha256")
		.update(stringField(input, "session_id"))
		.update("\0")
		.update(stringField(input, "turn_id"))
		.digest("hex");
	return join(pluginDataRoot(), `question-routing-${key}.json`);
}

function readOutcome(input) {
	try {
		const state = record(JSON.parse(readFileSync(statePath(input), "utf8")), "routing state");
		const outcome = state.outcome;
		if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) {
			throw new TypeError("routing state outcome is invalid");
		}
		return outcome;
	} catch (error) {
		if (error !== null && typeof error === "object" && error.code === "ENOENT") {
			return "not_attempted";
		}
		throw error;
	}
}

function writeOutcome(input, outcome) {
	if (!OUTCOMES.has(outcome)) {
		throw new TypeError("routing outcome is invalid");
	}
	writeFileSync(statePath(input), JSON.stringify({outcome}), {encoding: "utf8", mode: 0o600});
}

function clearOutcome(input) {
	rmSync(statePath(input), {force: true});
}

function isAskYepNope(toolName) {
	return /(^|__)ask_yep_nope$/u.test(toolName);
}

function isNativeQuestionTool(toolName) {
	return /^(request_user_input|AskUserQuestion)$/u.test(toolName);
}

function answeredToolResponse(toolResponse) {
	if (toolResponse === null || typeof toolResponse !== "object" || Array.isArray(toolResponse)) {
		return false;
	}
	if (toolResponse.isError === true || !Array.isArray(toolResponse.content)) {
		return false;
	}
	const text = toolResponse.content
		.filter((block) => block !== null && typeof block === "object" && block.type === "text")
		.map((block) => block.text)
		.filter((value) => typeof value === "string")
		.join("\n");
	return / -> (?:YEP|NOPE|SKIPPED\.)/u.test(text);
}

function asksDirectQuestion(message) {
	if (typeof message !== "string") {
		return false;
	}
	let insideFence = false;
	for (const line of message.split("\n")) {
		if (/^\s*(```|~~~)/u.test(line)) {
			insideFence = !insideFence;
			continue;
		}
		if (insideFence) {
			continue;
		}
		const prose = line
			.replace(/`[^`]*`/gu, "")
			.replace(/<https?:\/\/[^>]+>/gu, "")
			.replace(/\]\([^)]*\)/gu, "]")
			.trim();
		if (/^(?:📌\s*)?You asked:/u.test(prose)) {
			continue;
		}
		if (/\?(?:[*_~]+)?$/u.test(prose)) {
			return true;
		}
	}
	return false;
}

function nativeFallbackAllowed(outcome) {
	return outcome === "pending" || outcome === "fallback";
}

function handleHook(input) {
	const event = stringField(input, "hook_event_name");
	if (event === "UserPromptSubmit") {
		writeOutcome(input, "not_attempted");
		return {
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: ROUTING_INSTRUCTION,
			},
		};
	}
	if (event === "PreToolUse") {
		const toolName = stringField(input, "tool_name");
		if (isAskYepNope(toolName)) {
			writeOutcome(input, "pending");
			return undefined;
		}
		if (!isNativeQuestionTool(toolName)) {
			throw new Error(`unsupported PreToolUse tool: ${toolName}`);
		}
		if (nativeFallbackAllowed(readOutcome(input))) {
			return undefined;
		}
		return {
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: NATIVE_QUESTION_DENIAL,
			},
		};
	}
	if (event === "PostToolUse") {
		const toolName = stringField(input, "tool_name");
		if (!isAskYepNope(toolName)) {
			throw new Error(`unsupported PostToolUse tool: ${toolName}`);
		}
		writeOutcome(input, answeredToolResponse(input.tool_response) ? "answered" : "fallback");
		return undefined;
	}
	if (event === "Stop") {
		const asksQuestion = asksDirectQuestion(input.last_assistant_message);
		const outcome = readOutcome(input);
		clearOutcome(input);
		if (!asksQuestion) {
			return {};
		}
		if (nativeFallbackAllowed(outcome) || input.stop_hook_active === true) {
			return {};
		}
		return {decision: "block", reason: STOP_CONTINUATION};
	}
	throw new Error(`unsupported hook event: ${event}`);
}

const input = parseInput();
const output = handleHook(input);
if (output !== undefined) {
	process.stdout.write(JSON.stringify(output));
}
