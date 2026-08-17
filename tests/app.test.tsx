// @vitest-environment jsdom
import {act, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {QuestionsStream} from "../src/api";
import type {DeckQuestion, Disposition} from "../src/deck";

const initialQuestions: DeckQuestion[] = [
	{
		questionId: "batch-alice:0",
		batchId: "batch-alice",
		project: "demo",
		repo: null,
		branch: null,
		directory: null,
		title: "Ship it?",
		body: "",
	},
];

let publishQuestions: ((questions: DeckQuestion[]) => void) | undefined;
const closeStream = vi.fn<() => void>();
const refreshStream = vi.fn<() => void>();

vi.mock("../src/api", () => ({
	fetchAfk: vi.fn<() => Promise<boolean>>(async () => Promise.resolve(true)),
	issuePairingCode: vi.fn<() => Promise<{code: string; expiresAt: number}>>(),
	openQuestionsStream: vi.fn<(_token: string, onQuestions: (questions: DeckQuestion[]) => void) => QuestionsStream>(
		(_token, onQuestions) => {
			publishQuestions = onQuestions;
			return {close: closeStream, refresh: refreshStream};
		},
	),
	pairNew: vi.fn<() => Promise<string>>(async () => Promise.resolve("app-token-alice")),
	submitAnswer: vi.fn<(_token: string, _questionId: string, _disposition: Disposition) => Promise<void>>(async () =>
		Promise.resolve(),
	),
	updateAfk: vi.fn<(_token: string, afk: boolean) => Promise<boolean>>(async (_token, afk) => Promise.resolve(afk)),
}));

vi.mock("../src/token-store", () => ({
	loadToken: vi.fn<() => string>(() => "app-token-alice"),
	saveToken: vi.fn<() => Promise<void>>(async () => Promise.resolve()),
}));

vi.mock("../src/push", () => ({
	enablePush: vi.fn<() => Promise<"subscribed">>(async () => Promise.resolve("subscribed")),
	isIos: vi.fn<() => boolean>(() => false),
	isStandalone: vi.fn<() => boolean>(() => false),
	updateBadge: vi.fn<(_outstanding: number) => void>(),
}));

import {App} from "../src/app";
import {issuePairingCode} from "../src/api";
import {isIos, isStandalone} from "../src/push";

beforeEach(() => {
	publishQuestions = undefined;
	closeStream.mockClear();
	refreshStream.mockClear();
	vi.mocked(isIos).mockReturnValue(false);
	vi.mocked(isStandalone).mockReturnValue(false);
});

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

describe("App live question synchronization", () => {
	it("requires iPhone installation before notifications or pairing", async () => {
		vi.mocked(isIos).mockReturnValue(true);
		vi.mocked(isStandalone).mockReturnValue(false);

		render(<App />);
		await waitFor(() => {
			expect(publishQuestions).toBeTypeOf("function");
		});
		act(() => {
			publishQuestions?.([]);
		});
		fireEvent.click(screen.getByRole("button", {name: "Settings"}));

		expect(screen.getByRole("heading", {name: "Install first"})).toBeDefined();
		expect(screen.queryByRole("button", {name: "Enable notifications"})).toBeNull();
		expect(screen.queryByRole("button", {name: "Generate and copy pairing code"})).toBeNull();
		expect(screen.getByText(/pairing and notifications use the same app identity/i)).toBeDefined();
	});

	it("automatically copies and selects a generated pairing code", async () => {
		vi.mocked(issuePairingCode).mockResolvedValue({code: "ABC234", expiresAt: 1_787_000_000_000});
		const writeText = vi.fn<(text: string) => Promise<void>>(async () => Promise.resolve());
		Object.defineProperty(navigator, "clipboard", {configurable: true, value: {writeText}});

		render(<App />);
		await waitFor(() => {
			expect(publishQuestions).toBeTypeOf("function");
		});
		act(() => {
			publishQuestions?.([]);
		});
		fireEvent.click(screen.getByRole("button", {name: "Settings"}));
		fireEvent.click(screen.getByRole("button", {name: "Generate and copy pairing code"}));

		const code = await screen.findByText("ABC234");
		expect(code.tagName).toBe("CODE");
		await waitFor(() => {
			expect(writeText.mock.calls).toStrictEqual([["ABC234"]]);
			expect(screen.getByRole("status").textContent).toBe("📋 Copied to clipboard");
			expect(window.getSelection()?.toString()).toBe("ABC234");
		});
	});

	it("starts an async clipboard write during the generate-button activation", async () => {
		let resolvePairing: ((pairing: {code: string; expiresAt: number}) => void) | undefined;
		vi.mocked(issuePairingCode).mockImplementation(
			async () =>
				new Promise((resolve) => {
					resolvePairing = resolve;
				}),
		);
		class TestClipboardItem {
			constructor(readonly content: Record<string, Promise<Blob>>) {}
		}
		vi.stubGlobal("ClipboardItem", TestClipboardItem);
		const write = vi.fn<(_items: ClipboardItem[]) => Promise<void>>(async () => Promise.resolve());
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {write, writeText: vi.fn<(text: string) => Promise<void>>()},
		});

		render(<App />);
		await waitFor(() => {
			expect(publishQuestions).toBeTypeOf("function");
		});
		act(() => {
			publishQuestions?.([]);
		});
		fireEvent.click(screen.getByRole("button", {name: "Settings"}));
		fireEvent.click(screen.getByRole("button", {name: "Generate and copy pairing code"}));

		expect(write.mock.calls).toHaveLength(1);
		resolvePairing?.({code: "XYZ789", expiresAt: 1_787_000_000_000});
		expect(await screen.findByText("XYZ789")).toBeDefined();
	});

	it("discloses readable content, the lack of end-to-end encryption, and seven-day retention", async () => {
		render(<App />);
		await waitFor(() => {
			expect(publishQuestions).toBeTypeOf("function");
		});
		act(() => {
			publishQuestions?.([]);
		});

		fireEvent.click(screen.getByRole("button", {name: "Settings"}));

		expect(screen.getByRole("heading", {name: "Privacy and retention"}).parentElement?.textContent).toBe(
			"Privacy and retentionYepNope can read question bodies and answers. End-to-end encryption is not part of this MVP. Question bodies and answers are deleted seven days after each batch is created.",
		);
	});

	it("drops retracted cards as soon as the server publishes its empty state", async () => {
		render(<App />);
		await waitFor(() => {
			expect(publishQuestions).toBeTypeOf("function");
		});
		act(() => {
			publishQuestions?.(initialQuestions);
		});
		expect(screen.getByText("Ship it?")).toBeDefined();

		act(() => {
			publishQuestions?.([]);
		});

		expect(screen.getByText(/all caught up/i)).toBeDefined();
	});

	it("closes the live stream when the app unmounts", async () => {
		const rendered = render(<App />);
		await waitFor(() => {
			expect(publishQuestions).toBeTypeOf("function");
		});
		rendered.unmount();
		expect(closeStream.mock.calls).toStrictEqual([[]]);
	});
});
