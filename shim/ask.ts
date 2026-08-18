import {setTimeout as sleep} from "node:timers/promises";
import WebSocket from "ws";
import {z} from "zod";
import {parseFrame, type DispositionMap} from "../worker/protocol";
import {findLengthViolations, teachingRejection, type Disposition} from "../worker/validation";
import type {GitContext} from "./git-context";

// 🛑 Verbatim from spec §8.3: a tool error, not a result, so the model treats it as blocking.
export const QUOTA_EXHAUSTED_TEXT =
	"STOP. Question quota exhausted. Do not proceed and do not guess. Tell the user their quota " +
	"resets Tuesday at 4:00 AM, or that they can upgrade at yepnope.app/upgrade, then end your turn.";

// 🙅 A skip is a refusal to decide, never a license to choose (spec appendix A.2 step 14).
export const SKIP_INSTRUCTION =
	"SKIPPED. The user declined to decide. Leave this alone and report it; do not choose for them.";

const DEFAULT_HEARTBEAT_MILLISECONDS = 30_000;
const DEFAULT_PROGRESS_MILLISECONDS = 15_000;
const DEFAULT_RECONNECT_DELAY_MILLISECONDS = 2_000;
const DEFAULT_MAXIMUM_RECONNECT_DELAY_MILLISECONDS = 30_000;
const DEFAULT_MAXIMUM_CONSECUTIVE_FAILURES = 5;

export interface AskQuestion {
	title: string;
	body: string;
}

export interface AskBatch {
	project: string;
	questions: AskQuestion[];
}

export interface AskOptions {
	baseUrl: string;
	token: string;
	heartbeatMilliseconds?: number;
	maximumConsecutiveFailures?: number;
	maximumReconnectDelayMilliseconds?: number;
	progressMilliseconds?: number;
	random?: () => number;
	reconnectDelayMilliseconds?: number;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}

export interface AskOutcome {
	isError: boolean;
	text: string;
	// 🧮 Ordered by question position; empty on error. The caller feeds these to telemetry.
	dispositions: Disposition[];
}

const createdBatchSchema = z.object({batch_id: z.string(), question_ids: z.array(z.string())});
type CreatedBatch = z.infer<typeof createdBatchSchema>;

const afkErrorSchema = z.looseObject({message: z.string()});

type SocketResult =
	| {kind: "resolved"; dispositions: DispositionMap}
	| {kind: "error"; code: string; message: string}
	| {kind: "closed"; receivedState: boolean};

function errorOutcome(text: string): AskOutcome {
	return {isError: true, text, dispositions: []};
}

const DISPOSITION_SUFFIX: Record<Disposition, string> = {
	yep: "YEP",
	nope: "NOPE",
	skip: SKIP_INSTRUCTION,
};

function dispositionLine(title: string, disposition: Disposition): string {
	return `${title} -> ${DISPOSITION_SUFFIX[disposition]}`;
}

function streamUrl(baseUrl: string, batchId: string): string {
	const url = new URL(`/api/v1/questions/${batchId}/stream`, baseUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

// ⏳ The model-facing shape is one call that returns answers; the waiting lives here (spec §5).
export async function askYepNope(batch: AskBatch, context: GitContext, options: AskOptions): Promise<AskOutcome> {
	// 🧑‍🏫 Shim-layer length check (spec §7.2): an instruction the model can follow, not a 400.
	const violations = findLengthViolations(batch.questions);
	if (violations.length > 0) {
		return errorOutcome(teachingRejection(violations));
	}

	const response = await fetch(new URL("/api/v1/questions", options.baseUrl), {
		method: "POST",
		headers: {Authorization: `Bearer ${options.token}`, "Content-Type": "application/json"},
		body: JSON.stringify({
			project: batch.project,
			...(context.repo === null ? {} : {repo: context.repo}),
			...(context.branch === null ? {} : {branch: context.branch}),
			...(context.worktree === null ? {} : {worktree: context.worktree}),
			directory: context.directory,
			questions: batch.questions,
		}),
	});
	if (response.status === 409) {
		// 🧍 AFK is off (spec §11.3): surface the server's teaching error verbatim.
		const body = afkErrorSchema.safeParse(await response.json().catch(() => null));
		return errorOutcome(
			body.success
				? body.data.message
				: "AFK mode is off, so questions are not being routed to the user's phone.",
		);
	}
	if (response.status !== 201) {
		return errorOutcome(`The yepnope server rejected the batch with status ${response.status}.`);
	}
	const created = createdBatchSchema.parse(await response.json());
	return waitForResolution(batch, created, options);
}

async function waitForResolution(batch: AskBatch, created: CreatedBatch, options: AskOptions): Promise<AskOutcome> {
	const url = streamUrl(options.baseUrl, created.batch_id);
	let latest: DispositionMap = {};
	let consecutiveFailures = 0;
	const total = created.question_ids.length;
	// 🫀 Progress spans reconnects: the harness resets its tool timeout on each notification.
	const progressTimer = setInterval(() => {
		const answered = Object.values(latest).filter((disposition) => disposition !== null).length;
		options.onProgress?.(`Waiting on the user's phone: ${answered} of ${total} answered. Answers may take hours.`);
	}, options.progressMilliseconds ?? DEFAULT_PROGRESS_MILLISECONDS);

	try {
		for (;;) {
			if (options.signal?.aborted === true) {
				return errorOutcome("The ask_yep_nope call was cancelled before every question was answered.");
			}
			const result = await openStreamOnce(url, options, (dispositions) => {
				latest = dispositions;
			});
			if (result.kind === "resolved") {
				return resolvedOutcome(batch, created, result.dispositions);
			}
			if (result.kind === "error") {
				// 🛑 Spec §8.3: quota exhaustion blocks; the friction is the product.
				return errorOutcome(result.code === "quota_exhausted" ? QUOTA_EXHAUSTED_TEXT : result.message);
			}
			consecutiveFailures = result.receivedState ? 1 : consecutiveFailures + 1;
			const maximumConsecutiveFailures =
				options.maximumConsecutiveFailures ?? DEFAULT_MAXIMUM_CONSECUTIVE_FAILURES;
			if (consecutiveFailures >= maximumConsecutiveFailures) {
				return errorOutcome(
					`The yepnope answer stream stopped after ${maximumConsecutiveFailures} consecutive connection failures.`,
				);
			}
			await sleep(
				reconnectDelay(
					consecutiveFailures,
					options.reconnectDelayMilliseconds ?? DEFAULT_RECONNECT_DELAY_MILLISECONDS,
					options.maximumReconnectDelayMilliseconds ?? DEFAULT_MAXIMUM_RECONNECT_DELAY_MILLISECONDS,
					options.random ?? Math.random,
				),
			);
		}
	} finally {
		clearInterval(progressTimer);
	}
}

function reconnectDelay(
	consecutiveFailures: number,
	initialDelayMilliseconds: number,
	maximumDelayMilliseconds: number,
	random: () => number,
): number {
	const exponentialDelay = Math.min(
		maximumDelayMilliseconds,
		initialDelayMilliseconds * 2 ** (consecutiveFailures - 1),
	);
	return Math.round(Math.min(maximumDelayMilliseconds, exponentialDelay * (0.75 + random() * 0.5)));
}

function resolvedOutcome(batch: AskBatch, created: CreatedBatch, dispositions: DispositionMap): AskOutcome {
	const ordered: Disposition[] = [];
	const lines: string[] = [];
	for (const [position, question] of batch.questions.entries()) {
		const questionId = created.question_ids[position];
		const disposition = questionId === undefined ? null : (dispositions[questionId] ?? null);
		if (disposition === null) {
			return errorOutcome(`The batch resolved without a disposition for question ${position}.`);
		}
		ordered.push(disposition);
		lines.push(dispositionLine(question.title, disposition));
	}
	return {isError: false, text: lines.join("\n"), dispositions: ordered};
}

async function openStreamOnce(
	url: string,
	options: AskOptions,
	onState: (dispositions: DispositionMap) => void,
): Promise<SocketResult> {
	return new Promise<SocketResult>((resolve) => {
		const socket = new WebSocket(url, {headers: {Authorization: `Bearer ${options.token}`}});
		let heartbeatTimer: NodeJS.Timeout | undefined;
		let receivedState = false;
		let settled = false;

		const settle = (result: SocketResult): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (heartbeatTimer !== undefined) {
				clearInterval(heartbeatTimer);
			}
			options.signal?.removeEventListener("abort", onAbort);
			socket.terminate();
			resolve(result);
		};
		const onAbort = (): void => {
			settle({kind: "closed", receivedState});
		};
		options.signal?.addEventListener("abort", onAbort);

		socket.on("open", () => {
			// 💓 Any inbound frame is a heartbeat; missed beats let the server retract the deck
			// (batch identifier option C, .llm/decisions.md).
			heartbeatTimer = setInterval(() => {
				socket.send(JSON.stringify({type: "heartbeat"}));
			}, options.heartbeatMilliseconds ?? DEFAULT_HEARTBEAT_MILLISECONDS);
		});
		socket.on("message", (data) => {
			const frame = parseFrame(String(data));
			if (frame === null) {
				return;
			}
			if (frame.type === "state") {
				receivedState = true;
				onState(frame.dispositions);
				return;
			}
			if (frame.type === "resolved") {
				settle({kind: "resolved", dispositions: frame.dispositions});
				return;
			}
			settle({kind: "error", code: frame.code, message: frame.message});
		});
		socket.on("close", () => {
			settle({kind: "closed", receivedState});
		});
		socket.on("error", () => {
			settle({kind: "closed", receivedState});
		});
	});
}
