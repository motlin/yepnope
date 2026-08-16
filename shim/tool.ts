import {BODY_MAX_CHARACTERS, TITLE_MAX_CHARACTERS} from "../worker/validation";

export const TOOL_NAME = "ask_yep_nope";

// 🗣️ Verbatim from the spec (appendix A.2 step 0); iterate against real sessions, not in review.
export const TOOL_DESCRIPTION =
	"Ask the user yes/no questions on their phone. The user is away from their computer and will " +
	"answer by swiping. They cannot see your terminal and have forgotten the project context " +
	"entirely, so every question must be self-contained: state what you will do if they answer " +
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
