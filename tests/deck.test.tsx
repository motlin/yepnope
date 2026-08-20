// @vitest-environment jsdom
import {act, fireEvent, render, screen} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {Deck, FLY_OUT_MILLISECONDS, UNDO_WINDOW_MILLISECONDS, type DeckQuestion, type Disposition} from "../src/deck";

const QUESTIONS: DeckQuestion[] = [
	{
		questionId: "b1:0",
		batchId: "b1",
		project: "monorepo-migration",
		title: "Delete the legacy build?",
		body: "It has been **unused** for a year.",
		repo: "github.com/acme/rocket",
		branch: "migrate-build",
		directory: "/w/rocket/core",
	},
	{
		questionId: "b1:1",
		batchId: "b1",
		project: "monorepo-migration",
		title: "Squash the branch?",
		body: "Runs `git rebase -i` for you.",
		repo: "github.com/acme/rocket",
		branch: "migrate-build",
		directory: "/w/rocket/core",
	},
];

beforeEach(() => {
	vi.useFakeTimers();
	// 👆 jsdom ships no pointer capture, which the card claims on every pointer down.
	Element.prototype.setPointerCapture = vi.fn<(pointerId: number) => void>();
	Element.prototype.releasePointerCapture = vi.fn<(pointerId: number) => void>();
});

afterEach(() => {
	vi.useRealTimers();
});

function flyOut(): void {
	act(() => {
		vi.advanceTimersByTime(FLY_OUT_MILLISECONDS);
	});
}

function expireUndoWindow(): void {
	act(() => {
		vi.advanceTimersByTime(UNDO_WINDOW_MILLISECONDS);
	});
}

// The swipe only reaches the parent once the fly-out and the undo window are both over.
function settle(): void {
	flyOut();
	expireUndoWindow();
}

function undoButton(): HTMLElement {
	return screen.getByRole("button", {name: /undo/i});
}

function recordedMessage(): string {
	return screen.getByRole("status").textContent;
}

function undoCountdown(): string {
	const countdown = document.querySelector(".undo-countdown");
	if (!(countdown instanceof HTMLElement)) {
		throw new Error("the undo bar shows no countdown");
	}
	return countdown.textContent;
}

function cardWithChips(chips: Pick<DeckQuestion, "repo" | "branch" | "directory">): DeckQuestion {
	return {questionId: "b2:0", batchId: "b2", project: "demo", title: "Ship it?", body: "", ...chips};
}

function renderDeck(questions: DeckQuestion[]): HTMLElement {
	const {container} = render(
		<Deck questions={questions} onAnswer={vi.fn<(questionId: string, disposition: Disposition) => void>()} />,
	);
	return container;
}

function chipTexts(container: HTMLElement): (string | null)[] {
	return [...container.querySelectorAll(".chip")].map((chip) => chip.textContent);
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
		settle();
		expect(onAnswer.mock.calls).toEqual([["b1:0", "yep"]]);
	});

	it("commits nope and skip from the buttons", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		const {rerender} = render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", {name: /nope/i}));
		settle();
		rerender(<Deck questions={QUESTIONS.slice(1)} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", {name: /skip/i}));
		settle();
		expect(onAnswer.mock.calls).toEqual([
			["b1:0", "nope"],
			["b1:1", "skip"],
		]);
	});

	it("commits from arrow keys", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		const {rerender} = render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		fireEvent.keyDown(document, {key: "ArrowRight"});
		settle();
		rerender(<Deck questions={QUESTIONS.slice(1)} onAnswer={onAnswer} />);
		fireEvent.keyDown(document, {key: "ArrowLeft"});
		settle();
		expect(onAnswer.mock.calls).toEqual([
			["b1:0", "yep"],
			["b1:1", "nope"],
		]);
	});

	it("maps the down arrow to skip", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		fireEvent.keyDown(document, {key: "ArrowDown"});
		settle();
		expect(onAnswer.mock.calls).toEqual([["b1:0", "skip"]]);
	});

	it("ignores a second commit while the card is flying", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", {name: /yep/i}));
		fireEvent.click(screen.getByRole("button", {name: /nope/i}));
		settle();
		expect(onAnswer.mock.calls).toEqual([["b1:0", "yep"]]);
	});

	it("advances the counter as the parent removes answered questions", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		const {rerender} = render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", {name: /yep/i}));
		settle();
		rerender(<Deck questions={QUESTIONS.slice(1)} onAnswer={onAnswer} />);
		expect(screen.getByText("2 of 2")).toBeDefined();
		expect(screen.getByText("Squash the branch?")).toBeDefined();
	});

	it("shows repo, branch, and directory chips on the card", () => {
		expect(chipTexts(renderDeck(QUESTIONS))).toEqual(["github.com/acme/rocket", "migrate-build", "/w/rocket/core"]);
	});

	it("shows only the chips that have values", () => {
		const container = renderDeck([cardWithChips({repo: null, branch: "migrate-build", directory: null})]);
		expect(chipTexts(container)).toEqual(["migrate-build"]);
	});

	it("renders no chip row when the batch has no git context", () => {
		const container = renderDeck([cardWithChips({repo: null, branch: null, directory: null})]);
		expect(container.querySelector(".chip-row")).toBeNull();
	});

	it("shows the all-caught-up panel when the deck is empty", () => {
		render(<Deck questions={[]} onAnswer={vi.fn<(questionId: string, disposition: Disposition) => void>()} />);
		expect(screen.getByText(/all caught up/i)).toBeDefined();
	});
});

describe("Deck undo window", () => {
	it("holds the swipe and offers undo with the disposition and the remaining seconds", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", {name: /yep/i}));
		flyOut();
		expect(onAnswer.mock.calls).toEqual([]);
		expect(undoButton().getAttribute("aria-label")).toBe("Undo yep");
		expect(recordedMessage()).toBe("Yep recorded");
		expect(undoCountdown()).toBe("5s to undo");
	});

	it("counts the undo window down every second", () => {
		render(
			<Deck questions={QUESTIONS} onAnswer={vi.fn<(questionId: string, disposition: Disposition) => void>()} />,
		);
		fireEvent.click(screen.getByRole("button", {name: /nope/i}));
		flyOut();
		expect(undoCountdown()).toBe("5s to undo");
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(undoCountdown()).toBe("4s to undo");
		act(() => {
			vi.advanceTimersByTime(3000);
		});
		expect(undoCountdown()).toBe("1s to undo");
	});

	it("announces the recorded disposition without re-announcing the countdown", () => {
		render(
			<Deck questions={QUESTIONS} onAnswer={vi.fn<(questionId: string, disposition: Disposition) => void>()} />,
		);
		fireEvent.click(screen.getByRole("button", {name: /nope/i}));
		flyOut();
		const announcement = screen.getByRole("status");
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(announcement.textContent).toBe("Nope recorded");
		expect(announcement.querySelector(".undo-countdown")).toBeNull();
		expect(undoCountdown()).toBe("3s to undo");
	});

	it("submits once when the undo window lapses", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", {name: /yep/i}));
		settle();
		expect(onAnswer.mock.calls).toEqual([["b1:0", "yep"]]);
		expect(screen.queryByRole("status")).toBeNull();
		act(() => {
			vi.advanceTimersByTime(60_000);
		});
		expect(onAnswer.mock.calls).toEqual([["b1:0", "yep"]]);
	});

	it("puts the card back on top and rolls the counter back when undo is pressed", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", {name: /yep/i}));
		flyOut();
		expect(screen.getByText("Squash the branch?")).toBeDefined();
		expect(screen.getByText("2 of 2")).toBeDefined();
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		fireEvent.click(undoButton());
		expect(onAnswer.mock.calls).toEqual([]);
		expect(screen.getByText("Delete the legacy build?")).toBeDefined();
		expect(screen.getByText("1 of 2")).toBeDefined();
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("never submits an undone swipe once the window would have lapsed", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", {name: /yep/i}));
		flyOut();
		fireEvent.click(undoButton());
		act(() => {
			vi.advanceTimersByTime(60_000);
		});
		expect(onAnswer.mock.calls).toEqual([]);
	});

	it("undoes from the keyboard without touching the card", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		fireEvent.keyDown(document, {key: "ArrowRight"});
		flyOut();
		fireEvent.keyDown(document, {key: "U", shiftKey: true});
		act(() => {
			vi.advanceTimersByTime(60_000);
		});
		expect(onAnswer.mock.calls).toEqual([]);
		expect(screen.getByText("Delete the legacy build?")).toBeDefined();
	});

	it("leaves the browser shortcut alone when the undo key is pressed with a modifier", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		fireEvent.keyDown(document, {key: "ArrowRight"});
		flyOut();
		fireEvent.keyDown(document, {key: "u", metaKey: true});
		expireUndoWindow();
		expect(onAnswer.mock.calls).toEqual([["b1:0", "yep"]]);
	});

	it("holds the last card of a batch so the agent is not released early", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		render(<Deck questions={QUESTIONS.slice(1)} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", {name: /yep/i}));
		flyOut();
		expect(onAnswer.mock.calls).toEqual([]);
		expect(screen.getByText(/all caught up/i)).toBeDefined();
		fireEvent.click(undoButton());
		expect(screen.getByText("Squash the branch?")).toBeDefined();
		expect(screen.getByText("1 of 1")).toBeDefined();
		expect(onAnswer.mock.calls).toEqual([]);
	});

	it("releases the last card of a batch when its window lapses", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		render(<Deck questions={QUESTIONS.slice(1)} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", {name: /yep/i}));
		settle();
		expect(onAnswer.mock.calls).toEqual([["b1:1", "yep"]]);
	});

	it("submits the held swipe once when the next card is swiped inside the window", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		const {rerender} = render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", {name: /yep/i}));
		flyOut();
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		fireEvent.click(screen.getByRole("button", {name: /nope/i}));
		flyOut();
		expect(onAnswer.mock.calls).toEqual([["b1:0", "yep"]]);
		rerender(<Deck questions={QUESTIONS.slice(1)} onAnswer={onAnswer} />);
		expireUndoWindow();
		expect(onAnswer.mock.calls).toEqual([
			["b1:0", "yep"],
			["b1:1", "nope"],
		]);
	});

	it("keeps the swipe undone when the press and the lapse land in the same batch of work", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		fireEvent.click(screen.getByRole("button", {name: /yep/i}));
		flyOut();
		act(() => {
			vi.advanceTimersByTime(UNDO_WINDOW_MILLISECONDS - 1);
			fireEvent.click(undoButton());
			vi.advanceTimersByTime(UNDO_WINDOW_MILLISECONDS);
		});
		expect(onAnswer.mock.calls).toEqual([]);
		expect(screen.getByText("Delete the legacy build?")).toBeDefined();
	});
});

interface PointerPoint {
	pointerId: number;
	clientX: number;
	clientY: number;
}

function cardElement(container: HTMLElement): HTMLElement {
	const card = container.querySelector(".card");
	if (!(card instanceof HTMLElement)) {
		throw new Error("the deck rendered no card");
	}
	return card;
}

describe("Deck multi-touch", () => {
	it("commits a single-pointer swipe past the threshold", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		const {container} = render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		const card = cardElement(container);
		const finger: PointerPoint = {pointerId: 1, clientX: 0, clientY: 0};
		fireEvent.pointerDown(card, finger);
		fireEvent.pointerMove(card, {...finger, clientX: 150});
		expect(card.className).toContain("dragging");
		fireEvent.pointerUp(card, {...finger, clientX: 150});
		settle();
		expect(onAnswer.mock.calls).toEqual([["b1:0", "yep"]]);
	});

	it("cancels the drag when a second finger joins and commits nothing", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		const {container} = render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		const card = cardElement(container);
		fireEvent.pointerDown(card, {pointerId: 1, clientX: 0, clientY: 0});
		fireEvent.pointerMove(card, {pointerId: 1, clientX: 60, clientY: 0});
		expect(card.className).toContain("dragging");
		fireEvent.pointerDown(card, {pointerId: 2, clientX: 200, clientY: 40});
		expect(card.className).not.toContain("dragging");
		fireEvent.pointerMove(card, {pointerId: 2, clientX: 400, clientY: 40});
		fireEvent.pointerMove(card, {pointerId: 1, clientX: -400, clientY: 0});
		fireEvent.pointerUp(card, {pointerId: 1, clientX: -400, clientY: 0});
		fireEvent.pointerUp(card, {pointerId: 2, clientX: 400, clientY: 40});
		settle();
		expect(onAnswer.mock.calls).toEqual([]);
		expect(screen.getByText("Delete the legacy build?")).toBeDefined();
	});

	it("starts no drag from a second finger that lands while the first is down", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		const {container} = render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		const card = cardElement(container);
		fireEvent.pointerDown(card, {pointerId: 1, clientX: 0, clientY: 0});
		fireEvent.pointerDown(card, {pointerId: 2, clientX: 200, clientY: 0});
		fireEvent.pointerMove(card, {pointerId: 2, clientX: 400, clientY: 0});
		expect(card.className).not.toContain("dragging");
		fireEvent.pointerUp(card, {pointerId: 2, clientX: 400, clientY: 0});
		settle();
		expect(onAnswer.mock.calls).toEqual([]);
	});

	it("starts no drag from a finger that landed while the card was flying", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		const {container} = render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		const card = cardElement(container);
		fireEvent.click(screen.getByRole("button", {name: /yep/i}));
		fireEvent.pointerDown(card, {pointerId: 1, clientX: 0, clientY: 0});
		flyOut();
		fireEvent.pointerDown(card, {pointerId: 2, clientX: 0, clientY: 0});
		fireEvent.pointerMove(card, {pointerId: 2, clientX: 150, clientY: 0});
		expect(card.className).not.toContain("dragging");
	});

	it("drags again once every finger has lifted", () => {
		const onAnswer = vi.fn<(questionId: string, disposition: Disposition) => void>();
		const {container} = render(<Deck questions={QUESTIONS} onAnswer={onAnswer} />);
		const card = cardElement(container);
		fireEvent.pointerDown(card, {pointerId: 1, clientX: 0, clientY: 0});
		fireEvent.pointerDown(card, {pointerId: 2, clientX: 200, clientY: 0});
		fireEvent.pointerUp(card, {pointerId: 1, clientX: 0, clientY: 0});
		fireEvent.pointerUp(card, {pointerId: 2, clientX: 200, clientY: 0});
		fireEvent.pointerDown(card, {pointerId: 3, clientX: 0, clientY: 0});
		fireEvent.pointerMove(card, {pointerId: 3, clientX: -150, clientY: 0});
		fireEvent.pointerUp(card, {pointerId: 3, clientX: -150, clientY: 0});
		settle();
		expect(onAnswer.mock.calls).toEqual([["b1:0", "nope"]]);
	});
});
