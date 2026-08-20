import {BODY_MAX_CHARACTERS, TITLE_MAX_CHARACTERS} from "../worker/validation";
import {z} from "zod";
import type {Disposition} from "../worker/validation";

export const TOOL_NAME = "ask_yep_nope";

export const NATIVE_QUESTION_FALLBACK_TEXT =
	"YepNope phone routing is off. Immediately ask the same question through the client's native user-question tool.";

export const NATIVE_QUESTION_FALLBACK = {reason: "afk_off", route: "native"} as const;

export const ASK_YEP_NOPE_ARGUMENTS_SCHEMA = z.object({
	project: z.string().min(1),
	questions: z.array(z.object({title: z.string(), body: z.string()})).min(1),
});

export type AskYepNopeArguments = z.infer<typeof ASK_YEP_NOPE_ARGUMENTS_SCHEMA>;

export const SKIP_INSTRUCTION =
	"SKIPPED. The user declined to decide. Leave this alone and report it; do not choose for them.";

const DISPOSITION_SUFFIX: Record<Disposition, string> = {
	yep: "YEP",
	nope: "NOPE",
	skip: SKIP_INSTRUCTION,
};

export function formatAskYepNopeResult(
	questions: AskYepNopeArguments["questions"],
	dispositions: Disposition[],
): string {
	return questions
		.map((question, position) => {
			const disposition = dispositions[position];
			if (disposition === undefined) {
				throw new Error(`missing disposition for question ${String(position)}`);
			}
			return `${question.title} -> ${DISPOSITION_SUFFIX[disposition]}`;
		})
		.join("\n");
}

// 🗣️ Verbatim from the spec (appendix A.2 step 0); iterate against real sessions, not in review.
export const TOOL_DESCRIPTION =
	"Before using the client's native question flow for a blocking yes/no decision, call this tool. " +
	"It atomically checks the user's app-controlled phone-routing state. When routing is off, it " +
	"returns a native fallback instruction; immediately ask the same question through the client's " +
	"native user-question tool without asking the user to change routing. When routing is on, the user " +
	"answers on their phone by swiping. They cannot see your terminal and may have forgotten the " +
	"project context, so every question must be self-contained: state what you will do if they answer " +
	"yes, and give the context needed to decide, in that order. One decision per question. " +
	"Prefer phrasing where the expected answer is yes, but never use a negation in the title to " +
	"achieve it; a clear question with an expected no beats a confusing one with an expected " +
	"yes. Test each question against 'Yes means I will ______.' If that cannot be completed " +
	"with one concrete action, rewrite it. Ask only when guessing wrong would cost more than a " +
	"few minutes of rework. You may stack any number of questions; they are delivered as one " +
	"notification. The user may also skip a question, which means they declined to decide: " +
	"leave that item alone and report it rather than choosing for them. This call blocks until " +
	"every question is dispositioned, which may take hours.";

export const TOOL_INPUT_SCHEMA = {
	type: "object",
	required: ["project", "questions"],
	properties: {
		project: {type: "string", description: "Human-readable label for the work"},
		questions: {
			type: "array",
			minItems: 1,
			items: {
				type: "object",
				required: ["title", "body"],
				properties: {
					title: {type: "string", maxLength: TITLE_MAX_CHARACTERS},
					body: {
						type: "string",
						maxLength: BODY_MAX_CHARACTERS,
						description: "GitHub Flavored Markdown",
					},
				},
			},
		},
	},
} as const;

function schemaTypes<Input>(): {input: Input; output: Input} | undefined {
	return undefined;
}

export const ASK_YEP_NOPE_STANDARD_SCHEMA = {
	"~standard": {
		version: 1 as const,
		vendor: "yepnope",
		types: schemaTypes<AskYepNopeArguments>(),
		validate(value: unknown) {
			const parsed = ASK_YEP_NOPE_ARGUMENTS_SCHEMA.safeParse(value);
			return parsed.success
				? {value: parsed.data}
				: {issues: parsed.error.issues.map((issue) => ({message: issue.message, path: issue.path}))};
		},
		jsonSchema: {
			input: () => TOOL_INPUT_SCHEMA,
			output: () => TOOL_INPUT_SCHEMA,
		},
	},
};
