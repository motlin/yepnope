import {z} from "zod";
import {BODY_MAX_CHARACTERS, CONTEXT_MAX_CHARACTERS, TITLE_MAX_CHARACTERS, type Disposition} from "./validation";

export const TOOL_NAME = "ask_yep_nope";

export const NATIVE_QUESTION_FALLBACK_TEXT =
	"YepNope phone routing is off. Immediately ask the same question through the client's native user-question tool.";

export const NATIVE_QUESTION_FALLBACK = {reason: "afk_off", route: "native"} as const;

// 🧭 The card's chips. A remote MCP server cannot see the caller's filesystem, so the only way
// these ever reach a card is as tool arguments the agent fills in — which it will not do unless
// the schema and the description below ask for them by name.
const ASK_YEP_NOPE_ARGUMENTS_SCHEMA = z.object({
	project: z.string().min(1),
	repo: z.string().optional(),
	branch: z.string().optional(),
	worktree: z.string().optional(),
	directory: z.string().optional(),
	questions: z.array(z.object({title: z.string(), body: z.string()})).min(1),
});

export type AskYepNopeArguments = z.infer<typeof ASK_YEP_NOPE_ARGUMENTS_SCHEMA>;

const SKIP_INSTRUCTION =
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

// 🗣️ From the spec (appendix A.2 step 0), plus the context paragraph the chips need; iterate
// against real sessions, not in review.
export const TOOL_DESCRIPTION =
	"Before asking the user a yes/no question through any native or text flow, always call this tool " +
	"first. Route every yes/no decision through this tool regardless of its size, importance, or cost. " +
	"It atomically checks the user's app-controlled phone-routing state. When routing is off, it " +
	"returns a native fallback instruction; immediately ask the same question through the client's " +
	"native user-question tool without asking the user to change routing. When routing is on, the user " +
	"answers on their phone by swiping. They cannot see your terminal and may have forgotten the " +
	"project context, so every question must be self-contained: state what you will do if they answer " +
	"yes, and give the context needed to decide, in that order. The phone receives only the title, body, " +
	"and context chips from this call; it never receives console output, chat text, or anything printed " +
	"before the call. Copy every exact item needed for the decision into the body even when it already " +
	"appears elsewhere. For commit approval, include each short SHA and subject. Never use phrases such " +
	"as 'listed above', 'as discussed', 'these commits', or 'previous message' as a substitute for those " +
	"details. If the facts do not fit in one card, split them into independent questions rather than " +
	"referencing external context. One decision per question. " +
	"Prefer phrasing where the expected answer is yes, but never use a negation in the title to " +
	"achieve it; a clear question with an expected no beats a confusing one with an expected " +
	"yes. Test each question against 'Yes means I will ______.' If that cannot be completed " +
	"with one concrete action, rewrite it. You may stack any number of questions; they are delivered as one " +
	"notification. The user may also skip a question, which means they declined to decide: " +
	"leave that item alone and report it rather than choosing for them. This call blocks until " +
	"every question is dispositioned, which may take hours. " +
	"Whenever you are working in a git repository, fill in repo, branch, worktree, and directory " +
	"as well; they render on the card as the context the user needs to tell one of your sessions " +
	"from another. Derive them yourself from the shell, do not ask the user for them, and omit " +
	"any you cannot determine.";

export const TOOL_INPUT_SCHEMA = {
	type: "object",
	required: ["project", "questions"],
	properties: {
		project: {type: "string", description: "Human-readable label for the work"},
		repo: {
			type: "string",
			maxLength: CONTEXT_MAX_CHARACTERS,
			description: "Repository the work is in, `owner/name` style, from `git remote get-url origin`",
		},
		branch: {
			type: "string",
			maxLength: CONTEXT_MAX_CHARACTERS,
			description: "Checked-out branch, from `git rev-parse --abbrev-ref HEAD`",
		},
		worktree: {
			type: "string",
			maxLength: CONTEXT_MAX_CHARACTERS,
			description:
				"Absolute path of the worktree root, from `git rev-parse --show-toplevel`. Several " +
				"worktrees of one repository are often checked out at once and share a repo and often " +
				"a branch, so this is what tells the user which of them is asking",
		},
		directory: {
			type: "string",
			maxLength: CONTEXT_MAX_CHARACTERS,
			description: "Absolute path of your current working directory",
		},
		questions: {
			type: "array",
			minItems: 1,
			items: {
				type: "object",
				required: ["title", "body"],
				properties: {
					title: {
						type: "string",
						maxLength: TITLE_MAX_CHARACTERS,
						description: "Short yes-or-no decision that does not refer to console or chat context",
					},
					body: {
						type: "string",
						maxLength: BODY_MAX_CHARACTERS,
						description:
							"GitHub Flavored Markdown containing every phone-visible fact needed to decide. Copy exact " +
							"items rather than saying they were listed elsewhere; for commits, include each short SHA and subject.",
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
