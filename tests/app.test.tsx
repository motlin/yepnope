// @vitest-environment jsdom
import {act, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {
	AccountDevices,
	AuthenticationUser,
	CurrentDeckConnectionState,
	LiveApplicationState,
	OAuthClientSummary,
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
	email: "alice@example.com",
	emailVerified: true,
};

const fetchSession = vi.hoisted(() => vi.fn<() => Promise<AuthenticationUser | null>>());
const fetchOAuthClient = vi.hoisted(() =>
	vi.fn<(_clientId: string) => Promise<OAuthClientSummary>>(async () =>
		Promise.resolve({id: "oauth-client", name: "Codex", uri: null}),
	),
);
const resumeOAuthAuthorization = vi.hoisted(() => vi.fn<(_oauthQuery: string) => Promise<string>>());
const signInForOAuth = vi.hoisted(() =>
	vi.fn<(_email: string, _password: string, _oauthQuery: string) => Promise<string>>(),
);
const submitOAuthConsent = vi.hoisted(() => vi.fn<(_oauthQuery: string, _accept: boolean) => Promise<string>>());
const fetchAccountDevices = vi.hoisted(() =>
	vi.fn<() => Promise<AccountDevices>>(async () => Promise.resolve({machines: [], pushDevices: []})),
);
const claimLegacyIdentity = vi.hoisted(() => vi.fn<(_token: string) => Promise<void>>(async () => Promise.resolve()));
const renameMachine = vi.hoisted(() => vi.fn<(_id: string, _label: string) => Promise<void>>());
const renamePushDevice = vi.hoisted(() => vi.fn<(_id: string, _label: string) => Promise<void>>());
const revokeMachine = vi.hoisted(() =>
	vi.fn<(_id: string) => Promise<PairingStatus>>(async () =>
		Promise.resolve({paired: false, machineCount: 0, pendingPairingExpiresAt: null}),
	),
);
const revokePushDevice = vi.hoisted(() => vi.fn<(_id: string) => Promise<void>>());

const fetchPairingStatus = vi.hoisted(() =>
	vi.fn<() => Promise<PairingStatus>>(async () =>
		Promise.resolve({paired: true, machineCount: 1, pendingPairingExpiresAt: null}),
	),
);
const fetchAfk = vi.hoisted(() => vi.fn<() => Promise<boolean>>(async () => Promise.resolve(true)));
const updateAfk = vi.hoisted(() => vi.fn<(afk: boolean) => Promise<boolean>>(async (afk) => Promise.resolve(afk)));

let publishQuestions: ((questions: DeckQuestion[]) => void) | undefined;
let publishApplicationState: ((state: LiveApplicationState) => void) | undefined;
const closeStream = vi.fn<() => void>();
const refreshStream = vi.fn<() => void>();

vi.mock("../src/api", () => ({
	claimLegacyIdentity,
	fetchAccountDevices,
	fetchAfk,
	fetchPairingStatus,
	fetchOAuthClient,
	fetchSession,
	issuePairingCode: vi.fn<() => Promise<import("../src/api").IssuedPairingCode>>(),
	openCurrentDeckStream: vi.fn<(onState: (state: LiveApplicationState) => void) => CurrentDeckStream>((onState) => {
		publishApplicationState = onState;
		publishQuestions = (questions) => {
			onState({
				afk: true,
				pairingStatus: {paired: true, machineCount: 1, pendingPairingExpiresAt: null},
				currentDeck: questions,
			});
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
	resumeOAuthAuthorization,
	renameMachine,
	renamePushDevice,
	revokeMachine,
	revokePushDevice,
	sendVerificationEmail: vi.fn<() => Promise<void>>(async () => Promise.resolve()),
	signIn: vi.fn<() => Promise<AuthenticationUser>>(async () => Promise.resolve(alice)),
	signInForOAuth,
	signOut: vi.fn<() => Promise<void>>(async () => Promise.resolve()),
	submitOAuthConsent,
	submitAnswer: vi.fn<(_questionId: string, _disposition: Disposition) => Promise<void>>(async () =>
		Promise.resolve(),
	),
	updateAfk,
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
	signInForOAuth as signInForOAuthApi,
	submitOAuthConsent as submitOAuthConsentApi,
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
	fetchPairingStatus.mockResolvedValue({paired: true, machineCount: 1, pendingPairingExpiresAt: null});
	fetchOAuthClient.mockResolvedValue({id: "oauth-client", name: "Codex", uri: null});
	fetchSession.mockResolvedValue(alice);
	fetchAccountDevices.mockResolvedValue({machines: [], pushDevices: []});
	renameMachine.mockResolvedValue(undefined);
	renamePushDevice.mockResolvedValue(undefined);
	revokeMachine.mockResolvedValue({paired: false, machineCount: 0, pendingPairingExpiresAt: null});
	revokePushDevice.mockResolvedValue(undefined);
	resumeOAuthAuthorization.mockReturnValue(new Promise<string>(() => {}));
	signInForOAuth.mockReturnValue(new Promise<string>(() => {}));
	submitOAuthConsent.mockReturnValue(new Promise<string>(() => {}));
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

describe("OAuth consent continuity", () => {
	it("preserves the signed authorization request when a signed-out user signs in", async () => {
		const oauthQuery = new URLSearchParams({
			client_id: "oauth-client",
			resource: `${window.location.origin}/mcp`,
			scope: "openid offline_access yepnope:questions yepnope:afk",
			sig: "signed-authorization-request",
		}).toString();
		fetchSession.mockResolvedValueOnce(null).mockResolvedValueOnce(alice);
		signInForOAuth.mockResolvedValue(`${window.location.origin}/oauth/consent?${oauthQuery}`);
		window.history.replaceState({}, "", `/oauth/consent?${oauthQuery}`);

		render(<App />);

		expect(await screen.findByRole("heading", {name: "Sign in"})).toBeDefined();
		expect(`${window.location.pathname}${window.location.search}`).toBe(`/sign-in?${oauthQuery}`);
		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		fireEvent.change(screen.getByLabelText("Password"), {target: {value: "example-password"}});
		fireEvent.click(screen.getByRole("button", {name: "Sign in"}));

		await waitFor(() => {
			expect(vi.mocked(signInForOAuthApi).mock.calls).toStrictEqual([
				["alice@example.com", "example-password", oauthQuery],
			]);
			expect(screen.getByRole("heading", {name: "Authorize MCP client"})).toBeDefined();
		});
	});

	it("identifies the client, explains every scope, and offers explicit allow and cancel actions", async () => {
		const oauthQuery = new URLSearchParams({
			client_id: "oauth-client",
			resource: `${window.location.origin}/mcp`,
			scope: "openid offline_access yepnope:questions yepnope:afk",
			sig: "signed-authorization-request",
		}).toString();
		window.history.replaceState({}, "", `/oauth/consent?${oauthQuery}`);

		render(<App />);

		expect(await screen.findByText("Codex")).toBeDefined();
		expect(
			["Use your YepNope identity", "Stay connected", "Ask questions", "Manage AFK routing"].map(
				(label) => screen.getByText(label).textContent,
			),
		).toStrictEqual(["Use your YepNope identity", "Stay connected", "Ask questions", "Manage AFK routing"]);
		expect(screen.getByRole("button", {name: "Allow"})).toBeDefined();
		fireEvent.click(screen.getByRole("button", {name: "Cancel"}));

		await waitFor(() => {
			expect(vi.mocked(submitOAuthConsentApi).mock.calls).toStrictEqual([[oauthQuery, false]]);
		});
	});

	it("rejects unsupported scope and resource requests before loading client metadata", async () => {
		const oauthQuery = new URLSearchParams({
			client_id: "oauth-client",
			resource: `${window.location.origin}/different-resource`,
			scope: "openid admin",
			sig: "signed-authorization-request",
		}).toString();
		window.history.replaceState({}, "", `/oauth/consent?${oauthQuery}`);

		render(<App />);

		expect((await screen.findByRole("alert")).textContent).toBe(
			"This authorization request is invalid or has expired.",
		);
		expect({
			allow: screen.queryByRole("button", {name: "Allow"}),
			cancel: screen.queryByRole("button", {name: "Cancel"}),
			clientCalls: fetchOAuthClient.mock.calls,
		}).toStrictEqual({allow: null, cancel: null, clientCalls: []});
	});
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
		expect({
			appClass: document.querySelector(".app")?.className,
			pathname: window.location.pathname,
			title: document.title,
		}).toStrictEqual({
			appClass: "app app-settings",
			pathname: "/settings",
			title: "Settings · YepNope",
		});

		window.history.pushState({}, "", "/");
		fireEvent.popState(window);
		expect(
			screen.getByText("Your question queue is empty. New questions will appear here when they arrive.")
				.textContent,
		).toBe("Your question queue is empty. New questions will appear here when they arrive.");
		expect({appClass: document.querySelector(".app")?.className, title: document.title}).toStrictEqual({
			appClass: "app",
			title: "YepNope",
		});
	});

	it("keeps the real deck empty after pairing and refreshes the controls automatically", async () => {
		fetchPairingStatus.mockResolvedValue({paired: false, machineCount: 0, pendingPairingExpiresAt: null});
		const expiresAt = Date.now() + 60_000;
		vi.mocked(issuePairingCode).mockResolvedValue({
			code: "ABC234",
			expiresAt,
			pairingStatus: {paired: false, machineCount: 0, pendingPairingExpiresAt: expiresAt},
		});
		const writeText = vi.fn<(text: string) => Promise<void>>(async () => Promise.resolve());
		Object.defineProperty(navigator, "clipboard", {configurable: true, value: {writeText}});

		render(<App />);
		await waitFor(() => {
			expect(publishQuestions).toBeTypeOf("function");
		});
		act(() => {
			publishApplicationState?.({
				afk: false,
				pairingStatus: {paired: false, machineCount: 0, pendingPairingExpiresAt: null},
				currentDeck: [],
			});
		});

		expect((await screen.findByRole("button", {name: "Connect a CLI"})).getAttribute("aria-pressed")).toBeNull();
		expect(screen.getByRole("heading", {name: "All caught up"}).textContent).toBe("All caught up");

		fireEvent.click(screen.getByRole("button", {name: "Connect a CLI"}));
		expect(document.querySelector(".app-header .afk-toggle")).toBeNull();
		fireEvent.click(screen.getByRole("button", {name: "Generate and copy pairing code"}));
		expect(await screen.findByText("ABC234")).toBeDefined();
		expect({
			heading: screen.getByRole("heading", {name: "Waiting for your CLI"}).textContent,
			queueConfirmation: screen.queryByText(/all caught up/i),
			status: screen.getByRole("status").textContent,
		}).toStrictEqual({
			heading: "Waiting for your CLI",
			queueConfirmation: null,
			status: "Waiting for your CLI to claim this code.",
		});
		fireEvent.click(screen.getByRole("button", {name: "Back to the deck"}));
		expect(screen.getByRole("button", {name: "Waiting for CLI"}).textContent).toBe("Waiting for CLI");
		expect(
			screen.getByText("Your question queue is empty. New questions will appear here when they arrive.")
				.textContent,
		).toBe("Your question queue is empty. New questions will appear here when they arrive.");
		fireEvent.click(screen.getByRole("button", {name: "Waiting for CLI"}));

		fetchPairingStatus.mockResolvedValue({paired: true, machineCount: 1, pendingPairingExpiresAt: null});
		act(() => {
			publishApplicationState?.({
				afk: false,
				pairingStatus: {paired: true, machineCount: 1, pendingPairingExpiresAt: null},
				currentDeck: [],
			});
		});
		await waitFor(() => {
			expect(screen.getByRole("heading", {name: "Connect another CLI"}).textContent).toBe("Connect another CLI");
		});
		expect({
			code: screen.queryByText("ABC234"),
			generateButton: screen.getByRole("button", {name: "Generate and copy pairing code"}).textContent,
			heading: screen.getByRole("heading", {name: "Connect another CLI"}).textContent,
			repeatCopyButton: screen.queryByRole("button", {name: "Copy pairing code again"}),
		}).toStrictEqual({
			code: null,
			generateButton: "Generate and copy pairing code",
			heading: "Connect another CLI",
			repeatCopyButton: null,
		});
		act(() => {
			publishApplicationState?.({
				afk: false,
				pairingStatus: {paired: true, machineCount: 1, pendingPairingExpiresAt: null},
				currentDeck: [],
			});
		});
		expect(document.querySelector(".app-header .afk-toggle")).toBeNull();

		fireEvent.click(screen.getByRole("button", {name: "Back to the deck"}));
		expect(screen.getByRole("button", {name: "AFK off"}).getAttribute("aria-pressed")).toBe("false");
		expect(screen.getByRole("heading", {name: "All caught up"}).textContent).toBe("All caught up");
	});

	it("uses a bounded fallback while a pushed pairing result may be missed", async () => {
		fetchPairingStatus.mockResolvedValue({paired: false, machineCount: 0, pendingPairingExpiresAt: null});
		const expiresAt = Date.now() + 60_000;
		vi.mocked(issuePairingCode).mockResolvedValue({
			code: "JKM789",
			expiresAt,
			pairingStatus: {paired: false, machineCount: 0, pendingPairingExpiresAt: expiresAt},
		});
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {writeText: vi.fn<(text: string) => Promise<void>>(async () => Promise.resolve())},
		});

		render(<App />);
		await waitFor(() => {
			expect(publishApplicationState).toBeTypeOf("function");
		});
		act(() => {
			publishApplicationState?.({
				afk: false,
				pairingStatus: {paired: false, machineCount: 0, pendingPairingExpiresAt: null},
				currentDeck: [],
			});
		});
		fireEvent.click(screen.getByRole("button", {name: "Connect a CLI"}));
		vi.useFakeTimers();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", {name: "Generate and copy pairing code"}));
			await Promise.resolve();
		});
		expect(screen.getByRole("status").textContent).toBe("Waiting for your CLI to claim this code.");
		const callsBeforeFallback = fetchPairingStatus.mock.calls.length;
		fetchPairingStatus.mockResolvedValue({paired: true, machineCount: 1, pendingPairingExpiresAt: null});

		await act(async () => vi.advanceTimersByTimeAsync(4_999));
		expect(fetchPairingStatus.mock.calls).toHaveLength(callsBeforeFallback);
		await act(async () => vi.advanceTimersByTimeAsync(1));
		expect(fetchPairingStatus.mock.calls).toHaveLength(callsBeforeFallback + 1);
		expect(screen.getByRole("status").textContent).toBe("✓ CLI connected");
		await act(async () => vi.advanceTimersByTimeAsync(20_000));
		expect(fetchPairingStatus.mock.calls).toHaveLength(callsBeforeFallback + 1);
	});

	it("shows pairing immediately when the live state reports that the last machine was revoked", async () => {
		render(<App />);
		await waitFor(() => {
			expect(publishApplicationState).toBeTypeOf("function");
		});
		act(() => {
			publishApplicationState?.({
				afk: true,
				pairingStatus: {paired: true, machineCount: 1, pendingPairingExpiresAt: null},
				currentDeck: [],
			});
		});
		expect(screen.getByRole("button", {name: "AFK on"}).getAttribute("aria-pressed")).toBe("true");

		act(() => {
			publishApplicationState?.({
				afk: false,
				pairingStatus: {paired: false, machineCount: 0, pendingPairingExpiresAt: null},
				currentDeck: [],
			});
		});
		expect({
			headerPairingControls: [...document.querySelectorAll(".app-header .afk-toggle")].map(
				(control) => control.textContent,
			),
			pathname: window.location.pathname,
		}).toStrictEqual({headerPairingControls: [], pathname: "/"});

		fireEvent.click(screen.getByRole("button", {name: "Connect a CLI"}));
		expect({
			headerPairingControls: [...document.querySelectorAll(".app-header .afk-toggle")].map(
				(control) => control.textContent,
			),
			pairingHeading: screen.getByRole("heading", {name: "Connect a CLI"}).textContent,
			pathname: window.location.pathname,
		}).toStrictEqual({headerPairingControls: [], pairingHeading: "Connect a CLI", pathname: "/settings"});
	});

	it("exposes distinct accessible checking, off, and on AFK toggle states", async () => {
		let resolveAfk: ((afk: boolean) => void) | undefined;
		fetchAfk.mockImplementationOnce(
			async () =>
				new Promise((resolve) => {
					resolveAfk = resolve;
				}),
		);

		render(<App />);

		const checking = await screen.findByRole("button", {name: "Checking AFK…"});
		expect({
			ariaBusy: checking.getAttribute("aria-busy"),
			ariaPressed: checking.getAttribute("aria-pressed"),
			className: checking.className,
			disabled: (checking as HTMLButtonElement).disabled,
			text: checking.textContent,
			type: checking.getAttribute("type"),
		}).toStrictEqual({
			ariaBusy: "true",
			ariaPressed: null,
			className: "afk-toggle afk-checking",
			disabled: true,
			text: "Checking AFK…",
			type: "button",
		});

		await act(async () => {
			resolveAfk?.(false);
			await Promise.resolve();
		});
		const off = screen.getByRole("button", {name: "AFK off", pressed: false});
		expect({
			ariaBusy: off.getAttribute("aria-busy"),
			ariaPressed: off.getAttribute("aria-pressed"),
			className: off.className,
			disabled: (off as HTMLButtonElement).disabled,
			text: off.textContent,
			type: off.getAttribute("type"),
		}).toStrictEqual({
			ariaBusy: null,
			ariaPressed: "false",
			className: "afk-toggle afk-off",
			disabled: false,
			text: "AFK off",
			type: "button",
		});

		await act(async () => {
			fireEvent.click(off);
			await Promise.resolve();
		});
		const on = screen.getByRole("button", {name: "AFK on", pressed: true});
		expect({
			ariaBusy: on.getAttribute("aria-busy"),
			ariaPressed: on.getAttribute("aria-pressed"),
			className: on.className,
			disabled: (on as HTMLButtonElement).disabled,
			text: on.textContent,
			type: on.getAttribute("type"),
			updateCalls: updateAfk.mock.calls,
		}).toStrictEqual({
			ariaBusy: null,
			ariaPressed: "true",
			className: "afk-toggle afk-on",
			disabled: false,
			text: "AFK on",
			type: "button",
			updateCalls: [[true]],
		});
	});

	it("removes the redundant product name from the app header", async () => {
		render(<App />);
		await waitFor(() => {
			expect(publishQuestions).toBeTypeOf("function");
		});
		act(() => {
			publishQuestions?.([]);
		});

		expect(document.querySelector(".app-header")?.textContent).toBe("CLI connectedAFK on⚙");
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
		vi.mocked(issuePairingCode).mockResolvedValue({
			code: "ABC234",
			expiresAt: 2_000_000_000_000,
			pairingStatus: {paired: true, machineCount: 1, pendingPairingExpiresAt: 2_000_000_000_000},
		});
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
		const copyAgain = screen.getByRole("button", {name: "Copy pairing code again"});
		await waitFor(() => {
			expect({
				code: {
					ariaLabelledBy: code.getAttribute("aria-labelledby"),
					className: code.className,
					tabIndex: code.getAttribute("tabindex"),
					tagName: code.tagName,
					text: code.textContent,
				},
				copyAgain: {
					className: copyAgain.className,
					tabIndex: copyAgain.getAttribute("tabindex"),
					text: copyAgain.textContent,
					type: copyAgain.getAttribute("type"),
				},
				copyCalls: writeText.mock.calls,
				instruction: screen.getByText("Paste this code into the CLI you want to connect.").textContent,
				label: screen.getByText("Pairing code").textContent,
				note: screen.getByText("Expires in ten minutes and works once.").textContent,
				selection: window.getSelection()?.toString(),
				status: screen.getByRole("status").textContent,
				copyStatus: document.querySelector(".copy-status")?.textContent,
			}).toStrictEqual({
				code: {
					ariaLabelledBy: "pairing-code-label",
					className: "pairing-code",
					tabIndex: "0",
					tagName: "CODE",
					text: "ABC234",
				},
				copyAgain: {
					className: "pairing-copy-again",
					tabIndex: null,
					text: "Copy again",
					type: "button",
				},
				copyCalls: [["ABC234"]],
				instruction: "Paste this code into the CLI you want to connect.",
				label: "Pairing code",
				note: "Expires in ten minutes and works once.",
				selection: "ABC234",
				status: "Waiting for your CLI to claim this code.",
				copyStatus: "Copied to clipboard.",
			});
		});

		copyAgain.focus();
		window.getSelection()?.removeAllRanges();
		fireEvent.focus(code);
		expect(window.getSelection()?.toString()).toBe("ABC234");
		code.focus();
		expect(document.activeElement).toBe(code);
		copyAgain.focus();
		expect(document.activeElement).toBe(copyAgain);
		fireEvent.click(copyAgain);
		await waitFor(() => {
			expect(writeText.mock.calls).toStrictEqual([["ABC234"], ["ABC234"]]);
		});
	});

	it("keeps the selected code available when clipboard access is blocked", async () => {
		vi.mocked(issuePairingCode).mockResolvedValue({
			code: "DEF456",
			expiresAt: 2_000_000_000_000,
			pairingStatus: {paired: true, machineCount: 1, pendingPairingExpiresAt: 2_000_000_000_000},
		});
		const writeText = vi.fn<(text: string) => Promise<void>>(async () =>
			Promise.reject(new Error("Clipboard permission denied")),
		);
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

		const code = await screen.findByText("DEF456");
		await waitFor(() => {
			expect({
				copyCalls: writeText.mock.calls,
				selection: window.getSelection()?.toString(),
				status: document.querySelector(".copy-status")?.textContent,
			}).toStrictEqual({
				copyCalls: [["DEF456"]],
				selection: "DEF456",
				status: "Clipboard access is blocked. Copy the selected code manually.",
			});
		});

		window.getSelection()?.removeAllRanges();
		fireEvent.click(screen.getByRole("button", {name: "Copy pairing code again"}));
		await waitFor(() => {
			expect({
				copyCalls: writeText.mock.calls,
				selectedCode: window.getSelection()?.toString(),
				visibleCode: code.textContent,
			}).toStrictEqual({
				copyCalls: [["DEF456"], ["DEF456"]],
				selectedCode: "DEF456",
				visibleCode: "DEF456",
			});
		});
	});

	it("replaces an expired pairing code with a clear retry state", async () => {
		fetchPairingStatus.mockResolvedValue({paired: false, machineCount: 0, pendingPairingExpiresAt: null});
		vi.mocked(issuePairingCode).mockResolvedValue({
			code: "GHI678",
			expiresAt: 0,
			pairingStatus: {paired: false, machineCount: 0, pendingPairingExpiresAt: 0},
		});
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
		expect((await screen.findByText("GHI678")).textContent).toBe("GHI678");

		await waitFor(
			() => {
				expect({
					code: screen.queryByText("GHI678"),
					copyAgain: screen.queryByRole("button", {name: "Copy pairing code again"}),
					message: screen.getByText("That code expired. Generate a new one to try again.").textContent,
					retry: screen.getByRole("button", {name: "Generate and copy pairing code"}).textContent,
				}).toStrictEqual({
					code: null,
					copyAgain: null,
					message: "That code expired. Generate a new one to try again.",
					retry: "Generate and copy pairing code",
				});
			},
			{timeout: 2_000},
		);
	});

	it("starts an async clipboard write during the generate-button activation", async () => {
		let resolvePairing: ((pairing: import("../src/api").IssuedPairingCode) => void) | undefined;
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
		resolvePairing?.({
			code: "XYZ789",
			expiresAt: 2_000_000_000_000,
			pairingStatus: {paired: true, machineCount: 1, pendingPairingExpiresAt: 2_000_000_000_000},
		});
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
			expect(screen.getByRole("button", {name: "Sign in"}).textContent).toBe("Sign in");
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
			deckText: "All caught upYour question queue is empty. New questions will appear here when they arrive.",
			headerPairingControls: [],
			openedStream: false,
			storedCredentials: [],
		});
	});

	it("keeps the pairing header control off account routes reached from the signed-out deck", async () => {
		fetchSession.mockResolvedValue(null);
		const {container} = render(<App />);

		fireEvent.click(await screen.findByRole("button", {name: "Sign in"}));
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

		expect(await screen.findByText(/CLI connections belong to your account/i)).toBeDefined();
		expect(screen.queryByRole("button", {name: "Generate and copy pairing code"})).toBeNull();
		expect(screen.queryByRole("button", {name: "Enable notifications"})).toBeNull();
		expect(screen.getAllByRole("button", {name: /sign in/i}).map((button) => button.textContent)).toStrictEqual([
			"Sign in",
			"Sign in",
			"Sign in",
		]);
		expect(document.querySelector(".app-header .afk-toggle")).toBeNull();
	});

	it("registers an account and supports verification email resend", async () => {
		fetchSession.mockResolvedValue(null);
		window.history.replaceState({}, "", "/register");
		render(<App />);

		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		fireEvent.change(screen.getByLabelText("Password"), {target: {value: "example-password"}});
		fireEvent.click(screen.getByRole("button", {name: "Create account"}));

		expect(await screen.findByRole("heading", {name: "Check your email"})).toBeDefined();
		expect(vi.mocked(registerAccount).mock.calls).toStrictEqual([["alice@example.com", "example-password"]]);
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

		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		fireEvent.change(screen.getByLabelText("Password"), {target: {value: "example-password"}});
		fireEvent.click(screen.getByRole("button", {name: "Create account"}));

		expect(await screen.findByRole("heading", {name: "Check your email"})).toBeDefined();
		expect(screen.getByRole("alert").textContent).toBe("We couldn't send the email. Try again.");
		expect(vi.mocked(registerAccount).mock.calls).toStrictEqual([["alice@example.com", "example-password"]]);
		expect(vi.mocked(sendVerificationEmail).mock.calls).toStrictEqual([["alice@example.com"]]);
	});

	it("restores the verification-created browser session on the authenticated deck", async () => {
		window.history.replaceState({}, "", "/verify-email");
		render(<App />);

		fireEvent.click(await screen.findByRole("button", {name: "Settings"}));
		expect(await screen.findByText("alice@example.com")).toBeDefined();
		expect({
			fetchSessionCalls: fetchSession.mock.calls,
			pathname: window.location.pathname,
			signInCalls: vi.mocked(signIn).mock.calls,
		}).toStrictEqual({fetchSessionCalls: [[]], pathname: "/settings", signInCalls: []});
	});

	it("keeps invalid and expired verification link errors understandable", async () => {
		fetchSession.mockResolvedValue(null);
		window.history.replaceState({}, "", "/verify-email?error=TOKEN_EXPIRED");
		render(<App />);

		expect(await screen.findByRole("heading", {name: "Check your email"})).toBeDefined();
		expect(screen.getByRole("alert").textContent).toBe("That verification link is invalid or expired.");
		expect(screen.getByRole("button", {name: "Resend verification email"})).toBeDefined();
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
			return Promise.resolve({paired: false, machineCount: 0, pendingPairingExpiresAt: null});
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
			expect(screen.getByText("No connected CLIs.").textContent).toBe("No connected CLIs.");
			expect(screen.getByRole("heading", {name: "Connect a CLI"}).textContent).toBe("Connect a CLI");
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
		fireEvent.click(screen.getByRole("button", {name: "Sign in"}));
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
				pairingStatus: {paired: true, machineCount: 1, pendingPairingExpiresAt: null},
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
