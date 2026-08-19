import {z} from "zod";
import {buildPermissionCard} from "./hook-cards";
import {parseFrame} from "./protocol";
import type {UserDurableObject} from "./user-do";
import type {Disposition} from "./validation";

// 🪝 The Worker is the hook (spec §10.1): Claude Code POSTs hook JSON here, the Worker holds
// the request open on a WebSocket to the DO, the DO hibernates until the phone answers.

// 🐘 Hook payloads carry whole tool_inputs, so this route gets its own byte ceiling: the
// Worker only ever extracts a truncated salient string from them.
export const MAX_HOOK_REQUEST_BYTES = 1024 * 1024;

// 💓 Keeps the batch alive under heartbeat-and-delete (option C in .llm/decisions.md).
const HEARTBEAT_INTERVAL_MILLISECONDS = 30_000;

const hookEventSchema = z.looseObject({
	hook_event_name: z.string(),
	tool_name: z.string().optional(),
	tool_input: z.unknown().optional(),
	cwd: z.string().optional(),
});

type HookEvent = z.infer<typeof hookEventSchema>;

// 🧑‍🏫 Prompt surface (spec §11.4): teach the model to collapse a multi-option question into
// one yes-biased card instead of fanning it out into several.
const ASK_USER_QUESTION_REDIRECT =
	"AFK mode is on: the user is away from the keyboard and will not see AskUserQuestion prompts. " +
	"Ask through the ask_yep_nope tool instead, which sends yes/no cards to their phone. " +
	"Do not turn a multiple-choice question into several cards: pick the option you judge most likely " +
	"and ask a single 'proceed with X?' question. Restate all context in the question itself; " +
	"the user has not seen your terminal output.";

const PERMISSION_DENY_MESSAGE =
	"The user reviewed this permission request on their phone via YepNope and denied it. " +
	"Do not retry the same action; adjust your approach or ask a clarifying yes/no question first.";

// ✅ A bare allow carries no updatedInput: echoing the input back would re-run rule evaluation
// for no benefit, and the allow path has a history of regressions (spec §10.2).
type PermissionDecision = {behavior: "allow"} | {behavior: "deny"; message: string};

function noDecision(): Response {
	return Response.json({});
}

function preToolUseDeny(reason: string): Response {
	return Response.json({
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: reason,
		},
	});
}

function permissionDecision(decision: PermissionDecision): Response {
	return Response.json({
		hookSpecificOutput: {
			hookEventName: "PermissionRequest",
			decision,
		},
	});
}

// ⏳ The Worker, not the DO, owns the wait: a held-open request into the DO would block its
// hibernation, while a Worker parked on socket I/O is nearly free (spec §10.1).
async function waitForDisposition(
	stub: DurableObjectStub<UserDurableObject>,
	batchId: string,
	questionId: string,
): Promise<Disposition | null> {
	const upgrade = await stub.fetch(`https://do/api/v1/questions/${batchId}/stream`, {
		headers: {Upgrade: "websocket"},
	});
	const socket = upgrade.webSocket;
	if (socket === null) {
		return null;
	}
	socket.accept();
	return awaitResolution(socket, questionId);
}

async function awaitResolution(socket: WebSocket, questionId: string): Promise<Disposition | null> {
	return new Promise((resolve) => {
		let settled = false;
		const heartbeat = setInterval(() => {
			socket.send("beat");
		}, HEARTBEAT_INTERVAL_MILLISECONDS);
		function finish(disposition: Disposition | null): void {
			if (settled) {
				return;
			}
			settled = true;
			clearInterval(heartbeat);
			try {
				socket.close(1000, "hook resolved");
			} catch {
				// Already closed by the DO.
			}
			resolve(disposition);
		}
		socket.addEventListener("message", (event) => {
			const frame = typeof event.data === "string" ? parseFrame(event.data) : null;
			if (frame === null) {
				return;
			}
			if (frame.type === "resolved") {
				finish(frame.dispositions[questionId] ?? null);
			} else if (frame.type === "error") {
				finish(null);
			}
		});
		socket.addEventListener("close", () => {
			finish(null);
		});
		socket.addEventListener("error", () => {
			finish(null);
		});
	});
}

// 🧍 Interception point 2 (spec §11.3): deny AskUserQuestion with a redirect while AFK, abstain otherwise.
async function handlePreToolUse(
	event: HookEvent,
	stub: DurableObjectStub<UserDurableObject>,
	hasActiveConnectedMcpClient: boolean,
): Promise<Response> {
	if (event.tool_name !== "AskUserQuestion" || !(await stub.getAfk(hasActiveConnectedMcpClient))) {
		return noDecision();
	}
	return preToolUseDeny(ASK_USER_QUESTION_REDIRECT);
}

// 🧍 Interception point 1 (spec §11.3): route the permission prompt to the phone while AFK,
// fall through to the native terminal prompt otherwise.
async function handlePermissionRequest(
	event: HookEvent,
	stub: DurableObjectStub<UserDurableObject>,
	hasActiveConnectedMcpClient: boolean,
	executionContext: ExecutionContext,
): Promise<Response> {
	if (!(await stub.getAfk(hasActiveConnectedMcpClient))) {
		return noDecision();
	}
	const card = buildPermissionCard(event.tool_name ?? "unknown tool", event.tool_input, event.cwd);
	const created = await stub.createBatch({
		project: card.project,
		questions: [{title: card.title, body: card.body}],
	});
	executionContext.waitUntil(stub.sendBatchPush(created.batchId));
	const questionId = created.questionIds[0];
	if (questionId === undefined) {
		return noDecision();
	}
	const disposition = await waitForDisposition(stub, created.batchId, questionId);
	if (disposition === "yep") {
		return permissionDecision({behavior: "allow"});
	}
	if (disposition === "nope") {
		return permissionDecision({behavior: "deny", message: PERMISSION_DENY_MESSAGE});
	}
	// 🫥 Skip is terminal but not a decision, and a dropped socket is no answer at all:
	// both fall through to the native prompt.
	return noDecision();
}

export async function handleHookEvent(
	request: Request,
	stub: DurableObjectStub<UserDurableObject>,
	hasActiveConnectedMcpClient: boolean,
	executionContext: ExecutionContext,
): Promise<Response> {
	const parsed = hookEventSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return new Response(null, {status: 400});
	}
	switch (parsed.data.hook_event_name) {
		case "PreToolUse":
			return handlePreToolUse(parsed.data, stub, hasActiveConnectedMcpClient);
		case "PermissionRequest":
			return handlePermissionRequest(parsed.data, stub, hasActiveConnectedMcpClient, executionContext);
		default:
			return noDecision();
	}
}
