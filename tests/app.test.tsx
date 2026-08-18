// @vitest-environment jsdom
import {act, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {
	AccountDevices,
	AuthenticationUser,
	CurrentDeckConnectionState,
	LiveApplicationState,
	PairingStatus,
	CurrentDeckStream,
} from "../src/api";
import type {DeckQuestion, Disposition} from "../src/deck";

const streamedQuestions: DeckQuestion[] = [
	{
		questionId: "batch-alice:0",
		batchId: "batch-alice",
		project: "MCP test stream",
		repo: null,
		branch: null,
		directory: null,
		title: "Deploy the streamed test change?",
		body: "Delivered through the mocked current-deck stream.",
	},
];

const alice: AuthenticationUser = {
	id: "user-alice",
	name: "Alice",
	email: "alice@example.com",
	emailVerified: true,
};

const fetchSession = vi.hoisted(() => vi.fn<() => Promise<AuthenticationUser | null>>());
const fetchAccountDevices = vi.hoisted(() =>
	vi.fn<() => Promise<AccountDevices>>(async () => Promise.resolve({machines: [], pushDevices: []})),
);
const claimLegacyIdentity = vi.hoisted(() => vi.fn<(_token: string) => Promise<void>>(async () => Promise.resolve()));
const renameMachine = vi.hoisted(() => vi.fn<(_id: string, _label: string) => Promise<void>>());
const renamePushDevice = vi.hoisted(() => vi.fn<(_id: string, _label: string) => Promise<void>>());
const revokeMachine = vi.hoisted(() =>
	vi.fn<(_id: string) => Promise<PairingStatus>>(async () => Promise.resolve({paired: false, machineCount: 0})),
);
const revokePushDevice = vi.hoisted(() => vi.fn<(_id: string) => Promise<void>>());

const fetchPairingStatus = vi.hoisted(() =>
	vi.fn<() => Promise<PairingStatus>>(async () => Promise.resolve({paired: true, machineCount: 1})),
);

let publishQuestions: ((questions: DeckQuestion[]) => void) | undefined;
let publishApplicationState: ((state: LiveApplicationState) => void) | undefined;
const closeStream = vi.fn<() => void>();
const refreshStream = vi.fn<() => void>();

vi.mock("../src/api", () => ({
	claimLegacyIdentity,
	fetchAccountDevices,
	fetchAfk: vi.fn<() => Promise<boolean>>(async () => Promise.resolve(true)),
	fetchPairingStatus,
	fetchSession,
	issuePairingCode: vi.fn<() => Promise<{code: string; expiresAt: number}>>(),
	openCurrentDeckStream: vi.fn<(onState: (state: LiveApplicationState) => void) => CurrentDeckStream>((onState) => {
		publishApplicationState = onState;
		publishQuestions = (questions) => {
			onState({afk: true, pairingStatus: {paired: true, machineCount: 1}, currentDeck: questions});
		};
		return {
			close: closeStream,
			refresh: refreshStream,
			state: () => "open" as CurrentDeckConnectionState,
		};
	}),
	registerAccount: vi.fn<() => Promise<AuthenticationUser>>(async () => Promise.resolve(alice)),
	requestPasswordReset: vi.fn<() => Promise<void>>(async () => Promise.resolve()),
	resetPassword: vi.fn<() => Promise<void>>(async () => Promise.resolve()),
	renameMachine,
	renamePushDevice,
	revokeMachine,
	revokePushDevice,
	sendVerificationEmail: vi.fn<() => Promise<void>>(async () => Promise.resolve()),
	signIn: vi.fn<() => Promise<AuthenticationUser>>(async () => Promise.resolve(alice)),
	signOut: vi.fn<() => Promise<void>>(async () => Promise.resolve()),
	submitAnswer: vi.fn<(_questionId: string, _disposition: Disposition) => Promise<void>>(async () =>
		Promise.resolve(),
	),
	updateAfk: vi.fn<(afk: boolean) => Promise<boolean>>(async (afk) => Promise.resolve(afk)),
}));

vi.mock("../src/push", () => ({
	enablePush: vi.fn<() => Promise<"subscribed">>(async () => Promise.resolve("subscribed")),
	isIos: vi.fn<() => boolean>(() => false),
	isStandalone: vi.fn<() => boolean>(() => false),
	updateBadge: vi.fn<(_outstanding: number) => void>(),
}));

import {App} from "../src/app";
import {
	issuePairingCode,
	registerAccount,
	requestPasswordReset,
	resetPassword,
	sendVerificationEmail,
	signIn,
} from "../src/api";
import {isIos, isStandalone} from "../src/push";

beforeEach(() => {
	const storedValues = new Map<string, string>();
	const storage = {
		clear: () => {
			storedValues.clear();
		},
		getItem: (key: string) => storedValues.get(key) ?? null,
		key: (index: number) => [...storedValues.keys()][index] ?? null,
		get length() {
			return storedValues.size;
		},
		removeItem: (key: string) => {
			storedValues.delete(key);
		},
		setItem: (key: string, value: string) => {
			storedValues.set(key, value);
		},
	} satisfies Storage;
	Object.defineProperty(window, "localStorage", {configurable: true, value: storage});
	window.history.replaceState({}, "", "/");
	publishQuestions = undefined;
	publishApplicationState = undefined;
	closeStream.mockClear();
	refreshStream.mockClear();
	vi.mocked(isIos).mockReturnValue(false);
	vi.mocked(isStandalone).mockReturnValue(false);
	fetchPairingStatus.mockResolvedValue({paired: true, machineCount: 1});
	fetchSession.mockResolvedValue(alice);
	fetchAccountDevices.mockResolvedValue({machines: [], pushDevices: []});
	renameMachine.mockResolvedValue(undefined);
	renamePushDevice.mockResolvedValue(undefined);
	revokeMachine.mockResolvedValue({paired: false, machineCount: 0});
	revokePushDevice.mockResolvedValue(undefined);
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
		expect(
			screen.getByText("No questions waiting. Questions sent through your paired agent will appear here.")
				.textContent,
		).toBe("No questions waiting. Questions sent through your paired agent will appear here.");
		expect(document.title).toBe("YepNope");
	});

	it("keeps the real deck empty after pairing and refreshes the controls automatically", async () => {
		fetchPairingStatus.mockResolvedValue({paired: false, machineCount: 0});
		vi.mocked(issuePairingCode).mockResolvedValue({code: "ABC234", expiresAt: Date.now() + 60_000});
		const writeText = vi.fn<(text: string) => Promise<void>>(async () => Promise.resolve());
		Object.defineProperty(navigator, "clipboard", {configurable: true, value: {writeText}});

		render(<App />);
		await waitFor(() => {
			expect(publishQuestions).toBeTypeOf("function");
		});
		act(() => {
			publishApplicationState?.({
				afk: false,
				pairingStatus: {paired: false, machineCount: 0},
				currentDeck: [],
			});
		});

		expect((await screen.findByRole("button", {name: "Pair a machine"})).getAttribute("aria-pressed")).toBeNull();
		expect(screen.getByRole("heading", {name: "All caught up"}).textContent).toBe("All caught up");

		fireEvent.click(screen.getByRole("button", {name: "Pair a machine"}));
		expect(document.querySelector(".app-header .afk-toggle")).toBeNull();
		fireEvent.click(screen.getByRole("button", {name: "Generate and copy pairing code"}));
		expect(await screen.findByText("ABC234")).toBeDefined();

		fetchPairingStatus.mockResolvedValue({paired: true, machineCount: 1});
		await waitFor(
			() => {
				expect(screen.getByRole("status").textContent).toBe("✓ Machine paired");
			},
			{timeout: 2_000},
		);
		act(() => {
			publishApplicationState?.({
				afk: false,
				pairingStatus: {paired: true, machineCount: 1},
				currentDeck: [],
			});
		});
		expect(document.querySelector(".app-header .afk-toggle")).toBeNull();

		fireEvent.click(screen.getByRole("button", {name: "Back to the deck"}));
		expect(screen.getByRole("button", {name: "AFK off"}).getAttribute("aria-pressed")).toBe("false");
		expect(screen.getByRole("heading", {name: "All caught up"}).textContent).toBe("All caught up");
	});

	it("shows pairing immediately when the live state reports that the last machine was revoked", async () => {
		render(<App />);
		await waitFor(() => {
			expect(publishApplicationState).toBeTypeOf("function");
		});
		act(() => {
			publishApplicationState?.({
				afk: true,
				pairingStatus: {paired: true, machineCount: 1},
				currentDeck: [],
			});
		});
		expect(screen.getByRole("button", {name: "AFK on"}).getAttribute("aria-pressed")).toBe("true");

		act(() => {
			publishApplicationState?.({
				afk: false,
				pairingStatus: {paired: false, machineCount: 0},
				currentDeck: [],
			});
		});
		expect({
			headerPairingControls: [...document.querySelectorAll(".app-header .afk-toggle")].map(
				(control) => control.textContent,
			),
			pathname: window.location.pathname,
		}).toStrictEqual({headerPairingControls: ["Pair a machine"], pathname: "/"});

		fireEvent.click(screen.getByRole("button", {name: "Pair a machine"}));
		expect({
			headerPairingControls: [...document.querySelectorAll(".app-header .afk-toggle")].map(
				(control) => control.textContent,
			),
			pairingHeading: screen.getByRole("heading", {name: "Pair a machine"}).textContent,
			pathname: window.location.pathname,
		}).toStrictEqual({headerPairingControls: [], pairingHeading: "Pair a machine", pathname: "/settings"});
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
			"Privacy and retentionYepNope can read question bodies and answers. End-to-end encryption is not part of this MVP. Question bodies and current answers are deleted seven days after each batch is created. Activity outcomes are kept so your history totals remain explainable.",
		);
	});

	it("drops retracted cards as soon as the server publishes its empty state", async () => {
		render(<App />);
		await waitFor(() => {
			expect(publishQuestions).toBeTypeOf("function");
		});
		act(() => {
			publishQuestions?.(streamedQuestions);
		});
		expect(screen.getByText("Deploy the streamed test change?").textContent).toBe(
			"Deploy the streamed test change?",
		);

		act(() => {
			publishQuestions?.([]);
		});

		expect(screen.queryByText("Deploy the streamed test change?")).toBeNull();
		expect(screen.getByRole("heading", {name: "All caught up"}).textContent).toBe("All caught up");
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

describe("Better Auth account routes", () => {
	it("claims and removes a legacy browser token after restoring a verified session", async () => {
		window.localStorage.setItem("yepnope.token", "legacy-app-token-for-alice");

		render(<App />);

		await waitFor(() => {
			expect(claimLegacyIdentity.mock.calls).toStrictEqual([["legacy-app-token-for-alice"]]);
			expect(window.localStorage.getItem("yepnope.token")).toBeNull();
		});
	});

	it("shows an empty real deck without creating or storing a browser credential", async () => {
		fetchSession.mockResolvedValue(null);
		const storeCredential = vi.spyOn(window.localStorage, "setItem");

		const {container} = render(<App />);

		await waitFor(() => {
			expect(screen.getByRole("button", {name: "Sign in to pair"}).textContent).toBe("Sign in to pair");
		});
		expect({
			answerButtons: [...container.querySelectorAll(".actions button")].map((button) => button.textContent),
			cards: [...container.querySelectorAll(".card")].map((card) => card.textContent),
			deckText: container.querySelector(".deck")?.textContent,
			headerPairingControls: [...container.querySelectorAll(".app-header .afk-toggle")].map(
				(control) => control.textContent,
			),
			openedStream: publishQuestions !== undefined,
			storedCredentials: storeCredential.mock.calls,
		}).toStrictEqual({
			answerButtons: [],
			cards: [],
			deckText: "All caught upNo questions waiting. Questions sent through your paired agent will appear here.",
			headerPairingControls: ["Sign in to pair"],
			openedStream: false,
			storedCredentials: [],
		});
	});

	it("keeps the pairing header control off account routes reached from the signed-out deck", async () => {
		fetchSession.mockResolvedValue(null);
		const {container} = render(<App />);

		fireEvent.click(await screen.findByRole("button", {name: "Sign in to pair"}));
		expect({
			headerPairingControls: [...container.querySelectorAll(".app-header .afk-toggle")].map(
				(control) => control.textContent,
			),
			pathname: window.location.pathname,
		}).toStrictEqual({headerPairingControls: [], pathname: "/sign-in"});

		fireEvent.click(screen.getByRole("button", {name: "Create an account"}));
		expect({
			headerPairingControls: [...container.querySelectorAll(".app-header .afk-toggle")].map(
				(control) => control.textContent,
			),
			pathname: window.location.pathname,
		}).toStrictEqual({headerPairingControls: [], pathname: "/register"});

		fireEvent.click(screen.getByRole("button", {name: "Already have an account?"}));
		fireEvent.click(screen.getByRole("button", {name: "Forgot password?"}));
		expect({
			headerPairingControls: [...container.querySelectorAll(".app-header .afk-toggle")].map(
				(control) => control.textContent,
			),
			pathname: window.location.pathname,
		}).toStrictEqual({headerPairingControls: [], pathname: "/forgot-password"});

		window.history.pushState({}, "", "/reset-password?token=test-recovery-token");
		fireEvent.popState(window);
		expect({
			headerPairingControls: [...container.querySelectorAll(".app-header .afk-toggle")].map(
				(control) => control.textContent,
			),
			pathname: window.location.pathname,
		}).toStrictEqual({headerPairingControls: [], pathname: "/reset-password"});
	});

	it("requires an account before pairing or enabling notifications", async () => {
		fetchSession.mockResolvedValue(null);
		window.history.replaceState({}, "", "/settings");

		render(<App />);

		expect(await screen.findByText(/pairing belongs to your account/i)).toBeDefined();
		expect(screen.queryByRole("button", {name: "Generate and copy pairing code"})).toBeNull();
		expect(screen.queryByRole("button", {name: "Enable notifications"})).toBeNull();
		expect(screen.getAllByRole("button", {name: /sign in/i}).map((button) => button.textContent)).toStrictEqual([
			"Sign in",
			"Sign in",
			"Sign in to pair",
		]);
		expect(document.querySelector(".app-header .afk-toggle")).toBeNull();
	});

	it("registers an account and supports verification email resend", async () => {
		fetchSession.mockResolvedValue(null);
		window.history.replaceState({}, "", "/register");
		render(<App />);

		fireEvent.change(screen.getByRole("textbox", {name: "Name"}), {target: {value: "Alice"}});
		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		fireEvent.change(screen.getByLabelText("Password"), {target: {value: "example-password"}});
		fireEvent.click(screen.getByRole("button", {name: "Create account"}));

		expect(await screen.findByRole("heading", {name: "Check your email"})).toBeDefined();
		expect(vi.mocked(registerAccount).mock.calls).toStrictEqual([
			["Alice", "alice@example.com", "example-password"],
		]);
		expect(vi.mocked(sendVerificationEmail).mock.calls).toStrictEqual([["alice@example.com"]]);
		expect(screen.getByRole("status").textContent).toBe("Email sent. Check your inbox.");
		let finishResend: () => void = () => undefined;
		vi.mocked(sendVerificationEmail).mockReturnValueOnce(
			new Promise<void>((resolve) => {
				finishResend = resolve;
			}),
		);
		fireEvent.click(screen.getByRole("button", {name: "Resend verification email"}));
		const sendingButton = screen.getByRole("button", {name: "Sending…"});
		expect({
			ariaBusy: sendingButton.getAttribute("aria-busy"),
			disabled: (sendingButton as HTMLButtonElement).disabled,
		}).toStrictEqual({ariaBusy: "true", disabled: true});
		finishResend();
		await waitFor(() => {
			expect(vi.mocked(sendVerificationEmail).mock.calls).toStrictEqual([
				["alice@example.com"],
				["alice@example.com"],
			]);
			expect(screen.getByRole("status").textContent).toBe("Email sent. Check your inbox.");
		});
	});

	it("keeps a created account recoverable when verification delivery is rejected", async () => {
		fetchSession.mockResolvedValue(null);
		vi.mocked(sendVerificationEmail).mockRejectedValueOnce(new Error("Email delivery unavailable"));
		window.history.replaceState({}, "", "/register");
		render(<App />);

		fireEvent.change(screen.getByRole("textbox", {name: "Name"}), {target: {value: "Alice"}});
		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		fireEvent.change(screen.getByLabelText("Password"), {target: {value: "example-password"}});
		fireEvent.click(screen.getByRole("button", {name: "Create account"}));

		expect(await screen.findByRole("heading", {name: "Check your email"})).toBeDefined();
		expect(screen.getByRole("alert").textContent).toBe("We couldn't send the email. Try again.");
		expect(vi.mocked(registerAccount).mock.calls).toStrictEqual([
			["Alice", "alice@example.com", "example-password"],
		]);
		expect(vi.mocked(sendVerificationEmail).mock.calls).toStrictEqual([["alice@example.com"]]);
	});

	it("requests recovery and accepts the token delivered by Better Auth", async () => {
		fetchSession.mockResolvedValue(null);
		window.history.replaceState({}, "", "/forgot-password");
		const rendered = render(<App />);

		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		fireEvent.click(screen.getByRole("button", {name: "Send recovery email"}));
		await waitFor(() => {
			expect(vi.mocked(requestPasswordReset).mock.calls).toStrictEqual([["alice@example.com"]]);
			expect(screen.getByRole("status").textContent).toBe(
				"If that account exists, a recovery email was requested.",
			);
		});

		rendered.unmount();
		window.history.replaceState({}, "", "/reset-password?token=test-recovery-token");
		render(<App />);
		fireEvent.change(screen.getByLabelText("New password"), {target: {value: "replacement-password"}});
		fireEvent.click(screen.getByRole("button", {name: "Save new password"}));

		await waitFor(() => {
			expect(vi.mocked(resetPassword).mock.calls).toStrictEqual([
				["test-recovery-token", "replacement-password"],
			]);
			expect(screen.getByRole("status").textContent).toBe("Your password has been changed.");
		});
	});

	it("shows verified session state in account settings", async () => {
		window.history.replaceState({}, "", "/settings");
		render(<App />);

		expect(await screen.findByText("alice@example.com")).toBeDefined();
		expect(screen.getByText("✓ Verified email · Session active")).toBeDefined();
	});

	it("renames and revokes paired machines and browser notification devices", async () => {
		let accountDevices: AccountDevices = {
			machines: [{id: "machine-alice", label: "Alice laptop", createdAt: 946_684_800_000, lastUsedAt: null}],
			pushDevices: [{id: "push-alice", label: "Alice phone", createdAt: 946_684_800_000}],
		};
		fetchAccountDevices.mockImplementation(async () => Promise.resolve(accountDevices));
		renameMachine.mockImplementation(async (_id, label) => {
			accountDevices = {
				...accountDevices,
				machines: accountDevices.machines.map((machine) => ({...machine, label})),
			};
			return Promise.resolve();
		});
		revokePushDevice.mockImplementation(async () => {
			accountDevices = {...accountDevices, pushDevices: []};
			return Promise.resolve();
		});
		revokeMachine.mockImplementation(async () => {
			accountDevices = {...accountDevices, machines: []};
			return Promise.resolve({paired: false, machineCount: 0});
		});
		window.history.replaceState({}, "", "/settings");
		render(<App />);

		const machineRow = (await screen.findByText("Alice laptop")).closest("li");
		if (machineRow === null) {
			throw new Error("missing machine row");
		}
		fireEvent.click(within(machineRow).getByRole("button", {name: "Rename"}));
		fireEvent.change(within(machineRow).getByRole("textbox", {name: "Device name"}), {
			target: {value: "Work laptop"},
		});
		fireEvent.click(within(machineRow).getByRole("button", {name: "Save"}));
		await waitFor(() => {
			expect(renameMachine.mock.calls).toStrictEqual([["machine-alice", "Work laptop"]]);
			expect(screen.getByText("Work laptop").textContent).toBe("Work laptop");
		});

		const pushRow = screen.getByText("Alice phone").closest("li");
		if (pushRow === null) {
			throw new Error("missing push device row");
		}
		fireEvent.click(within(pushRow).getByRole("button", {name: "Revoke"}));
		await waitFor(() => {
			expect(revokePushDevice.mock.calls).toStrictEqual([["push-alice"]]);
			expect(screen.getByText("No browsers receive notifications.").textContent).toBe(
				"No browsers receive notifications.",
			);
		});

		const renamedMachineRow = screen.getByText("Work laptop").closest("li");
		if (renamedMachineRow === null) {
			throw new Error("missing renamed machine row");
		}
		fireEvent.click(within(renamedMachineRow).getByRole("button", {name: "Revoke"}));
		await waitFor(() => {
			expect(revokeMachine.mock.calls).toStrictEqual([["machine-alice"]]);
			expect(screen.getByText("No paired machines.").textContent).toBe("No paired machines.");
			expect(screen.getByRole("heading", {name: "Pair a machine"}).textContent).toBe("Pair a machine");
			expect(document.querySelector(".app-header .afk-toggle")).toBeNull();
		});
	});

	it("recovers the same account-owned deck after a second browser signs in", async () => {
		fetchSession.mockResolvedValue(alice);
		const firstBrowser = render(<App />);
		await waitFor(() => {
			expect(publishQuestions).toBeTypeOf("function");
		});
		act(() => publishQuestions?.(streamedQuestions));
		expect(screen.getByText("Deploy the streamed test change?").textContent).toBe(
			"Deploy the streamed test change?",
		);
		firstBrowser.unmount();

		publishQuestions = undefined;
		fetchSession.mockResolvedValue(null);
		window.history.replaceState({}, "", "/");
		render(<App />);
		fireEvent.click(screen.getByRole("button", {name: "Sign in to pair"}));
		expect(window.location.pathname).toBe("/sign-in");
		expect(document.querySelector(".app-header .afk-toggle")).toBeNull();
		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		fireEvent.change(screen.getByLabelText("Password"), {target: {value: "example-password"}});
		fireEvent.click(screen.getByRole("button", {name: /^Sign in$/}));
		await waitFor(() => {
			expect(vi.mocked(signIn).mock.calls).toStrictEqual([["alice@example.com", "example-password"]]);
			expect(publishQuestions).toBeTypeOf("function");
		});
		act(() => {
			publishApplicationState?.({
				afk: false,
				pairingStatus: {paired: true, machineCount: 1},
				currentDeck: streamedQuestions,
			});
		});
		fireEvent.click(screen.getByRole("button", {name: "Back to the deck"}));

		expect(screen.getByText("Deploy the streamed test change?").textContent).toBe(
			"Deploy the streamed test change?",
		);
		expect(screen.getByRole("button", {name: "AFK off"}).getAttribute("aria-pressed")).toBe("false");
		expect(fetchSession.mock.calls).toStrictEqual([[], []]);
	});
});
