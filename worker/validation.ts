import {z} from "zod";

// 📏 Limits settled in .llm/decisions.md (mockup measurements) and spec §7.
export const TITLE_MAX_CHARACTERS = 100;
export const BODY_MAX_CHARACTERS = 800;
// 🛡️ DoS byte ceiling, not a question cap (spec §7.3).
export const MAX_REQUEST_BYTES = 256 * 1024;
// 🗑️ Retention is derived from created_at, never stored (spec §13.1).
export const RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
// 💓 Heartbeat-and-delete grace (option C in .llm/decisions.md, spec §5): long enough that a
// closing laptop lid does not yank a deck mid-swipe, short enough that dead-agent cards do
// not linger. The shim beats every 30 s, so this is ten missed beats.
export const HEARTBEAT_GRACE_MILLISECONDS = 5 * 60 * 1000;

export const dispositionSchema = z.enum(["yep", "nope", "skip"]);
export type Disposition = z.infer<typeof dispositionSchema>;

const questionInputSchema = z.object({
	title: z.string().min(1).max(TITLE_MAX_CHARACTERS),
	body: z.string().max(BODY_MAX_CHARACTERS),
});
export type QuestionInput = z.infer<typeof questionInputSchema>;

// 🧭 Card chips (variant 2 in .llm/decisions.md): derived by the shim, absent for
// hook-sourced and non-git batches, so every field is optional. Malformed values are
// dropped, never rejected: chips are cosmetic and the model cannot fix a shim-derived
// path, so a 400 here would block the question over data nobody chose.
const CONTEXT_MAX_CHARACTERS = 256;
const contextFieldSchema = z.string().min(1).max(CONTEXT_MAX_CHARACTERS).optional().catch(undefined);

export const createBatchRequestSchema = z.object({
	project: z.string().min(1).max(TITLE_MAX_CHARACTERS),
	repo: contextFieldSchema,
	branch: contextFieldSchema,
	worktree: contextFieldSchema,
	directory: contextFieldSchema,
	questions: z.array(questionInputSchema).min(1),
});
export type CreateBatchRequest = z.infer<typeof createBatchRequestSchema>;

export const submitAnswersRequestSchema = z.object({
	answers: z
		.array(
			z.object({
				question_id: z.string().min(1),
				disposition: dispositionSchema,
			}),
		)
		.min(1),
});

// 🧑‍🏫 Shim-layer check (spec §7.2): instruction, not a stack trace. The Worker's
// 413/400 stays rude; this message is the prompt-engineering surface the model sees.
export interface LengthViolation {
	ordinal: number;
	field: "title" | "body";
	actualCharacters: number;
	maxCharacters: number;
}

const LENGTH_LIMITED_FIELDS = [
	{field: "title", maxCharacters: TITLE_MAX_CHARACTERS},
	{field: "body", maxCharacters: BODY_MAX_CHARACTERS},
] as const;

export function findLengthViolations(questions: QuestionInput[]): LengthViolation[] {
	const violations: LengthViolation[] = [];
	questions.forEach((question, ordinal) => {
		for (const {field, maxCharacters} of LENGTH_LIMITED_FIELDS) {
			const actualCharacters = question[field].length;
			if (actualCharacters > maxCharacters) {
				violations.push({ordinal, field, actualCharacters, maxCharacters});
			}
		}
	});
	return violations;
}

export function teachingRejection(violations: LengthViolation[]): string {
	const named = violations.map(
		(violation) =>
			`questions[${violation.ordinal}].${violation.field} is ${violation.actualCharacters} characters; ` +
			`the limit is ${violation.maxCharacters}.`,
	);
	return [
		...named,
		`Titles fit in ${TITLE_MAX_CHARACTERS} characters and bodies in ${BODY_MAX_CHARACTERS}.`,
		"Rewrite the over-length questions shorter and resend the whole batch; nothing is truncated for you.",
	].join(" ");
}

// 🧍 AFK mode (spec §11): a single server-side boolean, read per request, never cached.
export const afkRequestSchema = z.object({afk: z.boolean()});

// 🤝 Pairing codes expire ten minutes after issue (spec §12).
export const PAIRING_CODE_TTL_MILLISECONDS = 10 * 60 * 1000;

export const pairClaimRequestSchema = z.object({
	code: z
		.string()
		.min(1)
		.max(12)
		.transform((raw) => raw.trim().toUpperCase()),
	label: z.string().min(1).max(100),
});

export const legacyIdentityClaimRequestSchema = z.object({
	legacy_token: z.string().min(32).max(256),
});

export const pushSubscriptionSchema = z.object({
	endpoint: z.url(),
	keys: z.object({
		p256dh: z.string().min(1),
		auth: z.string().min(1),
	}),
});
