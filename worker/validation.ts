import {z} from "zod";

// 📏 Limits settled in .llm/decisions.md (mockup measurements) and spec §7.
export const TITLE_MAX_CHARACTERS = 100;
export const BODY_MAX_CHARACTERS = 800;
// 🛡️ DoS byte ceiling, not a question cap (spec §7.3).
export const MAX_REQUEST_BYTES = 256 * 1024;
// 🗑️ Retention is derived from created_at, never stored (spec §13.1).
export const RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

export const dispositionSchema = z.enum(["yep", "nope", "skip"]);
export type Disposition = z.infer<typeof dispositionSchema>;

const questionInputSchema = z.object({
	title: z.string().min(1).max(TITLE_MAX_CHARACTERS),
	body: z.string().max(BODY_MAX_CHARACTERS),
});

export const createBatchRequestSchema = z.object({
	project: z.string().min(1).max(TITLE_MAX_CHARACTERS),
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
