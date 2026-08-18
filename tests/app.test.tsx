// @vitest-environment jsdom
import {act, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {PairingStatus, QuestionsStream} from "../src/api";
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

const fetchPairingStatus = vi.hoisted(() =>
	vi.fn<() => Promise<PairingStatus>>(async () => Promise.resolve({paired: true, machineCount: 1})),
);

let publishQuestions: ((questions: DeckQuestion[]) => void) | undefined;
const closeStream = vi.fn<() => void>();
const refreshStream = vi.fn<() => void>();

vi.mock("../src/api", () => ({
	fetchAfk: vi.fn<() => Promise<boolean>>(async () => Promise.resolve(true)),
	fetchPairingStatus,
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
	window.history.replaceState({}, "", "/");
	publishQuestions = undefined;
	closeStream.mockClear();
	refreshStream.mockClear();
	vi.mocked(isIos).mockReturnValue(false);
	vi.mocked(isStandalone).mockReturnValue(false);
	fetchPairingStatus.mockResolvedValue({paired: true, machineCount: 1});
});

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

describe("App live question synchronization", () => {
	it("routes between the deck and settings with browser history", async () => {
		render(<App />);
		await waitFor(() => {
			expect(publishQuestions).toBeTypeOf("function");
		});
		act(() => {
			publishQuestions?.([]);
		});

		fireEvent.click(screen.getByRole("button", {name: "Settings"}));
		expect(window.location.pathname).toBe("/settings");
		expect(document.title).toBe("Settings · YepNope");

		window.history.pushState({}, "", "/");
		fireEvent.popState(window);
		expect(screen.getByText("Approve this sample change?")).toBeDefined();
		expect(document.title).toBe("YepNope");
	});

	it("keeps demo cards after pairing and refreshes the controls automatically", async () => {
		fetchPairingStatus.mockResolvedValue({paired: false, machineCount: 0});
		vi.mocked(issuePairingCode).mockResolvedValue({code: "ABC234", expiresAt: Date.now() + 60_000});
		const writeText = vi.fn<(text: string) => Promise<void>>(async () => Promise.resolve());
		Object.defineProperty(navigator, "clipboard", {configurable: true, value: {writeText}});

		render(<App />);
		await waitFor(() => {
			expect(publishQuestions).toBeTypeOf("function");
		});
		act(() => {
			publishQuestions?.([]);
		});

		expect((await screen.findByRole("button", {name: "Pair a machine"})).getAttribute("aria-pressed")).toBeNull();
		expect(screen.getByText("Approve this sample change?")).toBeDefined();
		expect(screen.getByText("1 of 3")).toBeDefined();

		fireEvent.click(screen.getByRole("button", {name: "Pair a machine"}));
		fireEvent.click(screen.getByRole("button", {name: "Generate and copy pairing code"}));
		expect(await screen.findByText("ABC234")).toBeDefined();

		fetchPairingStatus.mockResolvedValue({paired: true, machineCount: 1});
		await waitFor(
			() => {
				expect(screen.getByRole("status").textContent).toBe("✓ Machine paired");
			},
			{timeout: 2_000},
		);
		expect(screen.getByRole("button", {name: "AFK on"}).getAttribute("aria-pressed")).toBe("true");

		fireEvent.click(screen.getByRole("button", {name: "Back to the deck"}));
		expect(screen.getByText("Approve this sample change?")).toBeDefined();
		expect(screen.getByText("1 of 3")).toBeDefined();
	});

	it("removes the redundant product name from the app header", async () => {
		render(<App />);
		await waitFor(() => {
			expect(publishQuestions).toBeTypeOf("function");
		});
		act(() => {
			publishQuestions?.([]);
		});

		expect(document.querySelector(".app-header")?.textContent).toBe("AFK on⚙");
	});

	it("opens settings directly from its route", async () => {
		window.history.replaceState({}, "", "/settings");
		render(<App />);
		await waitFor(() => {
			expect(publishQuestions).toBeTypeOf("function");
		});
		act(() => {
			publishQuestions?.([]);
		});

		expect(screen.getByRole("heading", {name: "Notifications"})).toBeDefined();
		expect(screen.getByRole("button", {name: "Close settings"})).toBeDefined();
	});

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

		expect(screen.getByText("Approve this sample change?")).toBeDefined();
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
