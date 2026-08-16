import {describe, expect, it} from "vitest";
import {BODY_MAX_CHARACTERS, createBatchRequestSchema, dispositionSchema, TITLE_MAX_CHARACTERS} from "../validation";

describe("question schema limits", () => {
	it("uses the limits settled from the mockups", () => {
		expect(TITLE_MAX_CHARACTERS).toBe(100);
		expect(BODY_MAX_CHARACTERS).toBe(800);
	});

	it("accepts a batch at exactly the limits", () => {
		const result = createBatchRequestSchema.safeParse({
			project: "demo",
			questions: [{title: "x".repeat(100), body: "y".repeat(800)}],
		});
		expect(result.success).toBe(true);
	});

	it("has no semantic cap on question count", () => {
		const questions = Array.from({length: 200}, (_unused, index) => ({title: `Question ${index}?`, body: ""}));
		const result = createBatchRequestSchema.safeParse({project: "demo", questions});
		expect(result.success).toBe(true);
	});

	it("only accepts yep, nope, and skip", () => {
		expect(dispositionSchema.safeParse("yep").success).toBe(true);
		expect(dispositionSchema.safeParse("nope").success).toBe(true);
		expect(dispositionSchema.safeParse("skip").success).toBe(true);
		expect(dispositionSchema.safeParse("maybe").success).toBe(false);
	});
});
