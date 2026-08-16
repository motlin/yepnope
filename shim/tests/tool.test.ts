import {BODY_MAX_CHARACTERS, TITLE_MAX_CHARACTERS} from "../../worker/validation";
import {TOOL_DESCRIPTION, TOOL_INPUT_SCHEMA, TOOL_NAME} from "../tool";

describe("ask_yep_nope tool contract", () => {
	it("names the tool ask_yep_nope", () => {
		expect(TOOL_NAME).toBe("ask_yep_nope");
	});

	it("carries the verbatim description from the spec", () => {
		expect(TOOL_DESCRIPTION).toBe(
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
				"every question is dispositioned, which may take hours.",
		);
	});

	it("limits title and body to the settled lengths", () => {
		const question = TOOL_INPUT_SCHEMA.properties.questions.items.properties;
		expect(question.title.maxLength).toBe(TITLE_MAX_CHARACTERS);
		expect(question.body.maxLength).toBe(BODY_MAX_CHARACTERS);
	});

	it("requires project and at least one question", () => {
		expect(TOOL_INPUT_SCHEMA.required).toEqual(["project", "questions"]);
		expect(TOOL_INPUT_SCHEMA.properties.questions.minItems).toBe(1);
		expect(TOOL_INPUT_SCHEMA.properties.questions.items.required).toEqual(["title", "body"]);
	});
});
