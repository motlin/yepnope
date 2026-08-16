// @vitest-environment jsdom
import {act, fireEvent, render, screen} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {Deck, FLY_OUT_MILLISECONDS, type DeckQuestion, type Disposition} from "../src/deck";

const QUESTIONS: DeckQuestion[] = [
	{
		questionId: "b1:0",
		batchId: "b1",
		project: "monorepo-migration",
		title: "Delete the legacy build?",
		body: "It has been **unused** for a year.",
	},
	{
		questionId: "b1:1",
		batchId: "b1",
		project: "monorepo-migration",
		title: "Squash the branch?",
		body: "Runs `git rebase -i` for you.",
	},
];

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

function flyOut(): void {
	act(() => {
		vi.advanceTimersByTime(FLY_OUT_MILLISECONDS);
	});
}

describe("Deck", () => {
	it("shows the top card with rendered markdown and a counter", () => {
		render(
			<Deck questions={QUESTIONS} onAnswer={vi.fn<(questionId: string, disposition: Disposition) => void>()} />,
		);
		expect(screen.getByText("Delete the legacy build?")).toBeDefined();
		expect(screen.getByText("unused").tagName).toBe("B");
		expect(screen.getByText("monorepo-migration")).toBeDefined();
		expect(screen.getByText("1 of 2")).toBeDefined();
	});

	it("commits yep from the button after the fly-out animation", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", {name: /yep/i}));
		expect(onAnswer).not.toHaveBeenCalled();
		flyOut();
		expect(onAnswer.mock.calls).toEqual([["b1:0", "yep"]]);
	});

	it("commits nope and skip from the buttons", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		const {rerender} = render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", {name: /nope/i}));
		flyOut();
		rerender(<Deck questions={QUESTIONS.slice(1)} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", {name: /skip/i}));
		flyOut();
		expect(onAnswer.mock.calls).toEqual([
			["b1:0", "nope"],
			["b1:1", "skip"],
		]);
	});

	it("commits from arrow keys", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		const {rerender} = render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		fireEvent.keyDown(document, {key: "ArrowRight"});
		flyOut();
		rerender(<Deck questions={QUESTIONS.slice(1)} onAnswer={onAnswer} />);
		fireEvent.keyDown(document, {key: "ArrowLeft"});
		flyOut();
		expect(onAnswer.mock.calls).toEqual([
			["b1:0", "yep"],
			["b1:1", "nope"],
		]);
	});

	it("maps the down arrow to skip", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		fireEvent.keyDown(document, {key: "ArrowDown"});
		flyOut();
		expect(onAnswer.mock.calls).toEqual([["b1:0", "skip"]]);
	});

	it("ignores a second commit while the card is flying", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", {name: /yep/i}));
		fireEvent.click(screen.getByRole("button", {name: /nope/i}));
		flyOut();
		expect(onAnswer.mock.calls).toEqual([["b1:0", "yep"]]);
	});

	it("advances the counter as the parent removes answered questions", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		const {rerender} = render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", {name: /yep/i}));
		flyOut();
		rerender(<Deck questions={QUESTIONS.slice(1)} onAnswer={onAnswer} />);
		expect(screen.getByText("2 of 2")).toBeDefined();
		expect(screen.getByText("Squash the branch?")).toBeDefined();
	});

	it("shows the all-caught-up panel when the deck is empty", () => {
		render(<Deck questions={[]} onAnswer={vi.fn<(questionId: string, disposition: Disposition) => void>()} />);
		expect(screen.getByText(/all caught up/i)).toBeDefined();
	});
});
