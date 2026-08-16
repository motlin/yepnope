import {describe, expect, it} from "vitest";
import {
	BODY_MAX_CHARACTERS,
	createBatchRequestSchema,
	dispositionSchema,
	findLengthViolations,
	teachingRejection,
	TITLE_MAX_CHARACTERS,
} from "../validation";

describe("question schema limits", () => {
	it("uses the limits settled from the mockups", () => {
		expect(TITLE_MAX_CHARACTERS).toBe(100);
		expect(BODY_MAX_CHARACTERS).toBe(800);
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

describe("rejection, never truncation", () => {
	it("rejects an over-length title instead of truncating it", () => {
		const result = createBatchRequestSchema.safeParse({
			project: "demo",
			questions: [{title: "x".repeat(TITLE_MAX_CHARACTERS + 1), body: ""}],
		});
		expect(result.success).toBe(false);
	});

	it("rejects an over-length body instead of truncating it", () => {
		const result = createBatchRequestSchema.safeParse({
			project: "demo",
			questions: [{title: "Ship it?", body: "y".repeat(BODY_MAX_CHARACTERS + 1)}],
		});
		expect(result.success).toBe(false);
	});

	it("passes accepted questions through verbatim", () => {
		const questions = [{title: "x".repeat(TITLE_MAX_CHARACTERS), body: "y".repeat(BODY_MAX_CHARACTERS)}];
		const result = createBatchRequestSchema.safeParse({project: "demo", questions});
		expect(result.success).toBe(true);
		expect(result.data?.questions).toEqual(questions);
	});
});

describe("shim teaching errors", () => {
	it("finds every violation with its ordinal, field, and actual count", () => {
		const violations = findLengthViolations([
			{title: "Fine?", body: ""},
			{title: "t".repeat(140), body: "b".repeat(950)},
		]);
		expect(violations).toEqual([
			{ordinal: 1, field: "title", actualCharacters: 140, maxCharacters: TITLE_MAX_CHARACTERS},
			{ordinal: 1, field: "body", actualCharacters: 950, maxCharacters: BODY_MAX_CHARACTERS},
		]);
	});

	it("finds nothing when every question fits", () => {
		expect(findLengthViolations([{title: "Ship it?", body: "It is ready."}])).toEqual([]);
	});

	it("writes the rejection as instruction naming the offending question and its actual count", () => {
		const message = teachingRejection([
			{ordinal: 2, field: "body", actualCharacters: 950, maxCharacters: BODY_MAX_CHARACTERS},
		]);
		expect(message).toBe(
			"questions[2].body is 950 characters; the limit is 800. " +
				"Titles fit in 100 characters and bodies in 800. " +
				"Rewrite the over-length questions shorter and resend the whole batch; nothing is truncated for you.",
		);
	});

	it("names every offending question when several violate", () => {
		const message = teachingRejection([
			{ordinal: 0, field: "title", actualCharacters: 130, maxCharacters: TITLE_MAX_CHARACTERS},
			{ordinal: 3, field: "body", actualCharacters: 900, maxCharacters: BODY_MAX_CHARACTERS},
		]);
		expect(message).toContain("questions[0].title is 130 characters; the limit is 100.");
		expect(message).toContain("questions[3].body is 900 characters; the limit is 800.");
	});
});
