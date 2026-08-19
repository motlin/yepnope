// @vitest-environment jsdom
import {act, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {
	AccountDevices,
	AuthenticationUser,
	CurrentDeckConnectionState,
	CurrentDeckStream,
	CurrentDeckStreamOptions,
	LiveApplicationState,
	OAuthClientSummary,
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

const CODEX_ADD_COMMAND = "codex mcp add yepnope --url https://yepnope.app/mcp";
const CODEX_LOGIN_COMMAND = "codex mcp login yepnope";

const fetchSession = vi.hoisted(() => vi.fn<() => Promise<AuthenticationUser | null>>());
const ApiResponseError = vi.hoisted(
	() =>
		class extends Error {
			constructor(
				message: string,
				readonly status: number,
			) {
				super(message);
			}
		},
);
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
	vi.fn<() => Promise<AccountDevices>>(async () =>
		Promise.resolve({browserSessions: [], connectedMcpClients: [], pushDevices: []}),
	),
);
const claimLegacyIdentity = vi.hoisted(() => vi.fn<(_token: string) => Promise<void>>(async () => Promise.resolve()));
const renamePushDevice = vi.hoisted(() => vi.fn<(_id: string, _label: string) => Promise<void>>());
const revokeConnectedMcpClient = vi.hoisted(() =>
	vi.fn<(_id: string) => Promise<number>>(async () => await Promise.resolve(0)),
);
const revokePushDevice = vi.hoisted(() => vi.fn<(_id: string) => Promise<void>>());

const fetchAfk = vi.hoisted(() => vi.fn<() => Promise<boolean>>(async () => Promise.resolve(true)));
const updateAfk = vi.hoisted(() => vi.fn<(afk: boolean) => Promise<boolean>>(async (afk) => Promise.resolve(afk)));

let publishQuestions: ((questions: DeckQuestion[]) => void) | undefined;
let publishApplicationState: ((state: LiveApplicationState) => void) | undefined;
let expireSession: (() => void) | undefined;
const closeStream = vi.fn<() => void>();
const refreshStream = vi.fn<() => void>();

vi.mock("../src/api", () => ({
	ApiResponseError,
	claimLegacyIdentity,
	consumePasswordResetToken: vi.fn<() => Promise<void>>(async () => Promise.resolve()),
	fetchAccountDevices,
	fetchAfk,
	fetchOAuthClient,
	fetchSession,
	openCurrentDeckStream: vi.fn<
		(onState: (state: LiveApplicationState) => void, options?: CurrentDeckStreamOptions) => CurrentDeckStream
	>((onState, options) => {
		publishApplicationState = onState;
		expireSession = options?.onSignedOut;
		publishQuestions = (questions) => {
			onState({
				afk: true,
				connectedMcpClientCount: 1,
				currentDeck: questions,
			});
		};
		return {
			close: closeStream,
			refresh: refreshStream,
			state: () => "open" as CurrentDeckConnectionState,
		};
	}),
	registerAccount: vi.fn<() => Promise<void>>(async () => Promise.resolve()),
	requestPasswordReset: vi.fn<() => Promise<void>>(async () => Promise.resolve()),
	resumeOAuthAuthorization,
	renamePushDevice,
	revokeConnectedMcpClient,
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
	consumePasswordResetToken,
	registerAccount,
	requestPasswordReset,
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
	window.sessionStorage.clear();
	window.history.replaceState({}, "", "/");
	publishQuestions = undefined;
	publishApplicationState = undefined;
	expireSession = undefined;
	closeStream.mockClear();
	refreshStream.mockClear();
	vi.mocked(isIos).mockReturnValue(false);
	vi.mocked(isStandalone).mockReturnValue(false);
	fetchOAuthClient.mockResolvedValue({id: "oauth-client", name: "Codex", uri: null});
	fetchSession.mockResolvedValue(alice);
	fetchAccountDevices.mockResolvedValue({browserSessions: [], connectedMcpClients: [], pushDevices: []});
	renamePushDevice.mockResolvedValue(undefined);
	revokeConnectedMcpClient.mockResolvedValue(0);
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

	it("preserves OAuth through password reset and resumes at explicit consent after ordinary sign-in", async () => {
		const oauthQuery = new URLSearchParams({
			client_id: "oauth-client",
			resource: `${window.location.origin}/mcp`,
			scope: "openid offline_access yepnope:questions yepnope:afk",
			sig: "signed-password-reset-authorization",
		}).toString();
		fetchSession.mockResolvedValue(null);
		resumeOAuthAuthorization.mockResolvedValue(`${window.location.origin}/oauth/consent?${oauthQuery}`);
		window.history.replaceState({}, "", `/oauth/consent?${oauthQuery}`);

		render(<App />);

		fireEvent.click(await screen.findByRole("button", {name: "Forgot password?"}));
		expect(`${window.location.pathname}${window.location.search}`).toBe(`/forgot-password?${oauthQuery}`);
		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		fireEvent.click(screen.getByRole("button", {name: "Send recovery email"}));
		await waitFor(() => {
			expect(vi.mocked(requestPasswordReset).mock.calls).toStrictEqual([["alice@example.com"]]);
		});

		window.history.pushState({}, "", "/reset-password?token=oauth-reset-token");
		fireEvent.popState(window);
		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		fireEvent.change(screen.getByLabelText("New password"), {target: {value: "replacement-password"}});
		fireEvent.click(screen.getByRole("button", {name: "Save new password"}));

		expect(await screen.findByRole("heading", {name: "Authorize MCP client"})).toBeDefined();
		expect({
			consentCalls: submitOAuthConsent.mock.calls,
			oauthSignInCalls: signInForOAuth.mock.calls,
			path: `${window.location.pathname}${window.location.search}`,
			resetCalls: vi.mocked(consumePasswordResetToken).mock.calls,
			resumeCalls: resumeOAuthAuthorization.mock.calls,
			signInCalls: vi.mocked(signIn).mock.calls,
			storedContinuation: window.sessionStorage.getItem("yepnope.password-reset-oauth-query"),
		}).toStrictEqual({
			consentCalls: [],
			oauthSignInCalls: [],
			path: `/oauth/consent?${oauthQuery}`,
			resetCalls: [["oauth-reset-token", "replacement-password"]],
			resumeCalls: [[oauthQuery]],
			signInCalls: [["alice@example.com", "replacement-password"]],
			storedContinuation: null,
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

	it("refreshes connected-client settings when the live account state changes", async () => {
		fetchAccountDevices.mockResolvedValueOnce({browserSessions: [], connectedMcpClients: [], pushDevices: []});
		render(<App />);
		await waitFor(() => {
			expect(publishApplicationState).toBeTypeOf("function");
		});
		act(() => {
			publishApplicationState?.({
				afk: false,
				connectedMcpClientCount: 0,
				currentDeck: [],
			});
		});
		fireEvent.click(screen.getByRole("button", {name: "Connect an MCP client"}));
		expect(await screen.findByText("No connected MCP clients.")).toBeDefined();
		fetchAccountDevices.mockResolvedValue({
			browserSessions: [],
			connectedMcpClients: [
				{
					id: "a".repeat(64),
					displayName: "Codex on Alice laptop",
					authorizedAt: Date.UTC(2000, 0, 1),
					lastUsedAt: Date.UTC(2000, 0, 2),
					grantedScopes: ["openid", "yepnope:questions"],
					status: "active",
					revokedAt: null,
				},
			],
			pushDevices: [],
		});
		act(() => {
			publishApplicationState?.({afk: false, connectedMcpClientCount: 1, currentDeck: []});
		});
		expect(await screen.findByText("Codex on Alice laptop")).toBeDefined();
		expect(fetchAccountDevices.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("exposes distinct connection-checking, AFK-off, and AFK-on states", async () => {
		let resolveAfk: ((afk: boolean) => void) | undefined;
		fetchAfk.mockImplementationOnce(
			async () =>
				new Promise((resolve) => {
					resolveAfk = resolve;
				}),
		);

		render(<App />);

		const checking = await screen.findByRole("button", {name: "Checking account…"});
		expect({
			ariaPressed: checking.getAttribute("aria-pressed"),
			className: checking.className,
			disabled: (checking as HTMLButtonElement).disabled,
			text: checking.textContent,
			type: checking.getAttribute("type"),
		}).toStrictEqual({
			ariaPressed: null,
			className: "account-status",
			disabled: true,
			text: "Checking account…",
			type: "button",
		});

		await act(async () => {
			resolveAfk?.(false);
			await Promise.resolve();
			publishApplicationState?.({afk: false, connectedMcpClientCount: 1, currentDeck: []});
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

		expect(document.querySelector(".app-header")?.textContent).toBe("1 MCP client authorizedAFK on⚙");
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

		expect(screen.getByRole("heading", {name: "Connected MCP clients"})).toBeDefined();
		expect(screen.getByRole("heading", {name: "Signed-in browsers"})).toBeDefined();
		expect(screen.getByRole("heading", {name: "Browser notifications"})).toBeDefined();
		expect(screen.getByRole("button", {name: "Close settings"})).toBeDefined();
	});

	it.each([401, 403])("ends account refresh after an authenticated request returns %i", async (status) => {
		window.history.replaceState({}, "", "/settings");
		fetchAccountDevices.mockRejectedValueOnce(new ApiResponseError("Session expired", status));

		render(<App />);

		await waitFor(() => {
			expect(screen.getByRole("button", {name: "Sign in"})).toBeDefined();
		});
		expect({deviceRequests: fetchAccountDevices.mock.calls, path: window.location.pathname}).toStrictEqual({
			deviceRequests: [[]],
			path: "/",
		});
	});

	it("requires iPhone installation before browser notifications without hiding MCP setup", async () => {
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
		expect(screen.getByText(CODEX_ADD_COMMAND)).toBeDefined();
		expect(document.body.textContent.toLowerCase()).not.toContain("pair");
	});

	it("shows and copies current Codex remote MCP setup commands", async () => {
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
		const copyButtons = screen.getAllByRole("button", {name: "Copy"});
		fireEvent.click(copyButtons[0] ?? document.body);
		fireEvent.click(copyButtons[1] ?? document.body);
		await waitFor(() => {
			expect(writeText.mock.calls).toStrictEqual([[CODEX_ADD_COMMAND], [CODEX_LOGIN_COMMAND]]);
		});
		expect({
			addCommand: screen.getByText(CODEX_ADD_COMMAND).tagName,
			loginCommand: screen.getByText(CODEX_LOGIN_COMMAND).tagName,
			copiedButtons: screen.getAllByRole("button", {name: "Copied"}).length,
			docsUrl: screen.getByRole("link", {name: "Open the official Codex MCP instructions"}).getAttribute("href"),
		}).toStrictEqual({
			addCommand: "CODE",
			loginCommand: "CODE",
			copiedButtons: 2,
			docsUrl: "https://developers.openai.com/codex/mcp/",
		});
	});

	it("keeps setup commands selectable when clipboard access is blocked", async () => {
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
		fireEvent.click(screen.getAllByRole("button", {name: "Copy"})[0] ?? document.body);
		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toBe("Copy is blocked. Select the command manually.");
		});
		expect({
			copyCalls: writeText.mock.calls,
			command: screen.getByText(CODEX_ADD_COMMAND).textContent,
		}).toStrictEqual({
			copyCalls: [[CODEX_ADD_COMMAND]],
			command: CODEX_ADD_COMMAND,
		});
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

	it("shows only a clear account choice after direct signed-out navigation", async () => {
		fetchSession.mockResolvedValue(null);
		const storeCredential = vi.spyOn(window.localStorage, "setItem");

		const {container} = render(<App />);

		await waitFor(() => {
			expect(screen.getByRole("button", {name: "Sign in"}).textContent).toBe("Sign in");
		});
		expect({
			actions: [...container.querySelectorAll(".signed-out-actions button")].map((button) => ({
				className: button.className,
				text: button.textContent,
				type: button.getAttribute("type"),
			})),
			applicationText: container.querySelector(".app")?.textContent,
			authenticatedShell: container.querySelectorAll(".app-header, .deck, .settings, .actions, .card, .resolved")
				.length,
			openedStream: publishQuestions !== undefined,
			settingsControls: container.querySelectorAll(".settings-button, .afk-toggle, .account-status").length,
			storedCredentials: storeCredential.mock.calls,
		}).toStrictEqual({
			actions: [
				{className: "", text: "Sign in", type: "button"},
				{className: "secondary", text: "Create account", type: "button"},
			],
			applicationText:
				"YepNopeSign in to answer questions from your coding agents, or create an account to get started.Sign inCreate account",
			authenticatedShell: 0,
			openedStream: false,
			settingsControls: 0,
			storedCredentials: [],
		});
	});

	it("does not flash cached deck state while a reloaded session is being checked", async () => {
		let finishSessionCheck: (user: AuthenticationUser | null) => void = () => undefined;
		fetchSession.mockReturnValueOnce(
			new Promise((resolve) => {
				finishSessionCheck = resolve;
			}),
		);

		const {container} = render(<App />);

		expect({
			applicationText: container.querySelector(".app")?.textContent,
			authenticatedShell: container.querySelectorAll(".app-header, .deck, .settings").length,
		}).toStrictEqual({applicationText: "Checking your session…", authenticatedShell: 0});
		await act(async () => {
			finishSessionCheck(null);
			await Promise.resolve();
		});
		expect({
			actions: screen.getAllByRole("button").map((button) => button.textContent),
			authenticatedShell: container.querySelectorAll(".app-header, .deck, .settings").length,
			heading: screen.getByRole("heading").textContent,
		}).toStrictEqual({actions: ["Sign in", "Create account"], authenticatedShell: 0, heading: "YepNope"});
	});

	it("removes application chrome from signed-out account routes", async () => {
		fetchSession.mockResolvedValue(null);
		const {container} = render(<App />);

		fireEvent.click(await screen.findByRole("button", {name: "Sign in"}));
		expect({
			headers: [...container.querySelectorAll(".app-header")].map((header) => header.textContent),
			harnesses: screen.queryAllByRole("img", {name: "harness"}).map((icon) => icon.className),
			pathname: window.location.pathname,
			settingsControls: screen.queryAllByRole("button", {name: /settings/i}).map((button) => button.textContent),
		}).toStrictEqual({headers: [], harnesses: [], pathname: "/sign-in", settingsControls: []});

		fireEvent.click(screen.getByRole("button", {name: "Create an account"}));
		expect({
			headers: [...container.querySelectorAll(".app-header")].map((header) => header.textContent),
			harnesses: screen.queryAllByRole("img", {name: "harness"}).map((icon) => icon.className),
			pathname: window.location.pathname,
			settingsControls: screen.queryAllByRole("button", {name: /settings/i}).map((button) => button.textContent),
		}).toStrictEqual({headers: [], harnesses: [], pathname: "/register", settingsControls: []});

		fireEvent.click(screen.getByRole("button", {name: "Already have an account?"}));
		fireEvent.click(screen.getByRole("button", {name: "Forgot password?"}));
		expect({
			headers: [...container.querySelectorAll(".app-header")].map((header) => header.textContent),
			harnesses: screen.queryAllByRole("img", {name: "harness"}).map((icon) => icon.className),
			pathname: window.location.pathname,
			settingsControls: screen.queryAllByRole("button", {name: /settings/i}).map((button) => button.textContent),
		}).toStrictEqual({headers: [], harnesses: [], pathname: "/forgot-password", settingsControls: []});

		window.history.pushState({}, "", "/reset-password?token=test-recovery-token");
		fireEvent.popState(window);
		expect({
			headers: [...container.querySelectorAll(".app-header")].map((header) => header.textContent),
			harnesses: screen.queryAllByRole("img", {name: "harness"}).map((icon) => icon.className),
			pathname: window.location.pathname,
			settingsControls: screen.queryAllByRole("button", {name: /settings/i}).map((button) => button.textContent),
		}).toStrictEqual({headers: [], harnesses: [], pathname: "/reset-password", settingsControls: []});
	});

	it("redirects direct signed-out settings navigation to the landing state", async () => {
		fetchSession.mockResolvedValue(null);
		window.history.replaceState({}, "", "/settings");

		render(<App />);

		expect(await screen.findByRole("heading", {name: "YepNope"})).toBeDefined();
		expect({
			actions: screen.getAllByRole("button").map((button) => button.textContent),
			authenticatedShell: document.querySelectorAll(".app-header, .deck, .settings").length,
			pathname: window.location.pathname,
		}).toStrictEqual({actions: ["Sign in", "Create account"], authenticatedShell: 0, pathname: "/"});
	});

	it("returns failed sign-in and browser back navigation to the signed-out landing", async () => {
		fetchSession.mockResolvedValue(null);
		vi.mocked(signIn).mockRejectedValueOnce(
			new ApiResponseError("Sign-in failed. Check your email and password, or recover your account.", 401),
		);
		window.history.replaceState({}, "", "/sign-in");
		const {container} = render(<App />);

		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		fireEvent.change(screen.getByLabelText("Password"), {target: {value: "wrong-password"}});
		fireEvent.click(screen.getByRole("button", {name: "Sign in"}));
		expect((await screen.findByRole("alert")).textContent).toBe(
			"Sign-in failed. Check your email and password, or recover your account.",
		);
		fireEvent.click(screen.getByRole("button", {name: "Back to YepNope"}));
		expect({
			actions: screen.getAllByRole("button").map((button) => button.textContent),
			authenticatedShell: container.querySelectorAll(".app-header, .deck, .settings").length,
			pathname: window.location.pathname,
		}).toStrictEqual({actions: ["Sign in", "Create account"], authenticatedShell: 0, pathname: "/"});

		fireEvent.click(screen.getByRole("button", {name: "Create account"}));
		window.history.pushState({}, "", "/");
		fireEvent.popState(window);
		expect({
			actions: screen.getAllByRole("button").map((button) => button.textContent),
			authenticatedShell: container.querySelectorAll(".app-header, .deck, .settings").length,
			pathname: window.location.pathname,
		}).toStrictEqual({actions: ["Sign in", "Create account"], authenticatedShell: 0, pathname: "/"});
	});

	it("registers an account and supports verification email resend", async () => {
		fetchSession.mockResolvedValue(null);
		window.history.replaceState({}, "", "/register");
		render(<App />);

		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		fireEvent.change(screen.getByLabelText("Password"), {target: {value: "example-password"}});
		fireEvent.click(screen.getByRole("button", {name: "Create account"}));

		expect(await screen.findByRole("heading", {name: "Verify your email"})).toBeDefined();
		expect(vi.mocked(registerAccount).mock.calls).toStrictEqual([["alice@example.com", "example-password"]]);
		expect(vi.mocked(sendVerificationEmail).mock.calls).toStrictEqual([["alice@example.com"]]);
		expect({
			buttons: screen.getAllByRole("button").map((button) => ({
				ariaBusy: button.getAttribute("aria-busy"),
				disabled: (button as HTMLButtonElement).disabled,
				text: button.textContent,
				type: button.getAttribute("type"),
			})),
			emailInput: screen.queryByRole("textbox", {name: "Email"}),
			headers: document.querySelectorAll(".app-header").length,
			instruction: screen.getByText(
				"If verification is available, use the emailed link to finish creating your account.",
			).textContent,
			status: screen.queryByRole("status"),
		}).toStrictEqual({
			buttons: [
				{ariaBusy: "false", disabled: false, text: "Resend verification email", type: "button"},
				{ariaBusy: null, disabled: false, text: "Back to sign in", type: "button"},
				{ariaBusy: null, disabled: false, text: "Back to YepNope", type: "button"},
			],
			emailInput: null,
			headers: 0,
			instruction: "If verification is available, use the emailed link to finish creating your account.",
			status: null,
		});
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
			expect(screen.getByRole("status").textContent).toBe(
				"If verification is available, a new link will arrive by email.",
			);
		});
		fireEvent.click(screen.getByRole("button", {name: "Back to sign in"}));
		expect({
			headers: document.querySelectorAll(".app-header").length,
			pathname: window.location.pathname,
			title: document.title,
		}).toStrictEqual({headers: 0, pathname: "/sign-in", title: "Sign in · YepNope"});
	});

	it("keeps a created account recoverable when verification delivery is rejected", async () => {
		fetchSession.mockResolvedValue(null);
		vi.mocked(sendVerificationEmail).mockRejectedValueOnce(new Error("Email delivery unavailable"));
		window.history.replaceState({}, "", "/register");
		render(<App />);

		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		fireEvent.change(screen.getByLabelText("Password"), {target: {value: "example-password"}});
		fireEvent.click(screen.getByRole("button", {name: "Create account"}));

		expect(await screen.findByRole("heading", {name: "Verify your email"})).toBeDefined();
		expect(screen.getByRole("alert").textContent).toBe("We couldn't submit that request. Try again.");
		expect(vi.mocked(registerAccount).mock.calls).toStrictEqual([["alice@example.com", "example-password"]]);
		expect(vi.mocked(sendVerificationEmail).mock.calls).toStrictEqual([["alice@example.com"]]);
		expect(screen.queryByRole("textbox", {name: "Email"})).toBeNull();
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

		expect(await screen.findByRole("heading", {name: "Verify your email"})).toBeDefined();
		expect({
			alert: screen.getByRole("alert").textContent,
			emailInput: screen.getByRole("textbox", {name: "Email"}).getAttribute("value"),
			instruction: screen.getByText("Enter your email to request another verification link.").textContent,
			resendButtonType: screen.getByRole("button", {name: "Resend verification email"}).getAttribute("type"),
		}).toStrictEqual({
			alert: "That verification link is invalid or expired.",
			emailInput: "",
			instruction: "Enter your email to request another verification link.",
			resendButtonType: "submit",
		});
	});

	it("requests recovery, consumes the token, and signs in with the replacement password", async () => {
		fetchSession.mockResolvedValue(null);
		window.history.replaceState({}, "", "/forgot-password");
		const rendered = render(<App />);

		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		fireEvent.click(screen.getByRole("button", {name: "Send recovery email"}));
		await waitFor(() => {
			expect(vi.mocked(requestPasswordReset).mock.calls).toStrictEqual([["alice@example.com"]]);
			expect(screen.getByRole("status").textContent).toBe(
				"If recovery is available for that address, check its inbox for next steps.",
			);
		});

		rendered.unmount();
		window.history.replaceState({}, "", "/reset-password?token=test-recovery-token");
		render(<App />);
		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		fireEvent.change(screen.getByLabelText("New password"), {target: {value: "replacement-password"}});
		fireEvent.click(screen.getByRole("button", {name: "Save new password"}));

		await waitFor(() => {
			expect(vi.mocked(consumePasswordResetToken).mock.calls).toStrictEqual([
				["test-recovery-token", "replacement-password"],
			]);
			expect(vi.mocked(signIn).mock.calls).toStrictEqual([["alice@example.com", "replacement-password"]]);
			expect(window.location.pathname).toBe("/settings");
		});
	});

	it("never retries a consumed reset token when the follow-up sign-in fails", async () => {
		fetchSession.mockResolvedValue(null);
		vi.mocked(signIn).mockRejectedValueOnce(new Error("Sign-in temporarily unavailable"));
		window.history.replaceState({}, "", "/reset-password?token=single-use-reset-token");
		render(<App />);

		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alic@example.com"}});
		fireEvent.change(screen.getByLabelText("New password"), {target: {value: "replacement-password"}});
		fireEvent.click(screen.getByRole("button", {name: "Save new password"}));

		expect((await screen.findByRole("alert")).textContent).toBe("Sign-in temporarily unavailable");
		expect({
			path: `${window.location.pathname}${window.location.search}`,
			resetCalls: vi.mocked(consumePasswordResetToken).mock.calls,
			signInCalls: vi.mocked(signIn).mock.calls,
			status: screen.getByRole("status").textContent,
		}).toStrictEqual({
			path: "/reset-password",
			resetCalls: [["single-use-reset-token", "replacement-password"]],
			signInCalls: [["alic@example.com", "replacement-password"]],
			status: "Your password has been changed.",
		});

		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		fireEvent.click(screen.getByRole("button", {name: "Try signing in again"}));
		await waitFor(() => {
			expect(window.location.pathname).toBe("/settings");
		});
		expect({
			resetCalls: vi.mocked(consumePasswordResetToken).mock.calls,
			signInCalls: vi.mocked(signIn).mock.calls,
		}).toStrictEqual({
			resetCalls: [["single-use-reset-token", "replacement-password"]],
			signInCalls: [
				["alic@example.com", "replacement-password"],
				["alice@example.com", "replacement-password"],
			],
		});
	});

	it("keeps expired and replayed reset-token failures in the reset state", async () => {
		fetchSession.mockResolvedValue(null);
		vi.mocked(consumePasswordResetToken).mockRejectedValueOnce(new Error("Invalid token"));
		window.history.replaceState({}, "", "/reset-password?token=expired-reset-token");
		render(<App />);

		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		fireEvent.change(screen.getByLabelText("New password"), {target: {value: "replacement-password"}});
		fireEvent.click(screen.getByRole("button", {name: "Save new password"}));

		expect((await screen.findByRole("alert")).textContent).toBe("Invalid token");
		expect({
			resetCalls: vi.mocked(consumePasswordResetToken).mock.calls,
			resetSubmitPresent: screen.getByRole("button", {name: "Save new password"}).textContent,
			signInCalls: vi.mocked(signIn).mock.calls,
		}).toStrictEqual({
			resetCalls: [["expired-reset-token", "replacement-password"]],
			resetSubmitPresent: "Save new password",
			signInCalls: [],
		});
	});

	it("shows verified session state in account settings", async () => {
		window.history.replaceState({}, "", "/settings");
		render(<App />);

		expect(await screen.findByText("alice@example.com")).toBeDefined();
		expect(screen.getByText("✓ Verified email · Session active")).toBeDefined();
	});

	it("clears the authenticated shell on logout and ignores stale stream state", async () => {
		window.history.replaceState({}, "", "/settings");
		const {container} = render(<App />);
		await screen.findByText("alice@example.com");

		fireEvent.click(screen.getByRole("button", {name: "Sign out"}));
		await waitFor(() => {
			expect(window.location.pathname).toBe("/");
		});
		act(() => {
			publishApplicationState?.({afk: true, connectedMcpClientCount: 1, currentDeck: streamedQuestions});
		});
		expect({
			actions: screen.getAllByRole("button").map((button) => button.textContent),
			authenticatedShell: container.querySelectorAll(".app-header, .deck, .settings").length,
			closeCalls: closeStream.mock.calls,
			question: screen.queryByText("Deploy the streamed test change?"),
		}).toStrictEqual({
			actions: ["Sign in", "Create account"],
			authenticatedShell: 0,
			closeCalls: [[]],
			question: null,
		});
	});

	it("clears the authenticated shell when the live session expires", async () => {
		const {container} = render(<App />);
		await waitFor(() => {
			expect(expireSession).toBeTypeOf("function");
		});
		act(() => {
			publishApplicationState?.({afk: true, connectedMcpClientCount: 1, currentDeck: streamedQuestions});
			expireSession?.();
		});
		expect({
			actions: screen.getAllByRole("button").map((button) => button.textContent),
			authenticatedShell: container.querySelectorAll(".app-header, .deck, .settings").length,
			pathname: window.location.pathname,
			question: screen.queryByText("Deploy the streamed test change?"),
		}).toStrictEqual({
			actions: ["Sign in", "Create account"],
			authenticatedShell: 0,
			pathname: "/",
			question: null,
		});
	});

	it("revokes connected MCP clients separately from browser notification devices", async () => {
		let accountDevices: AccountDevices = {
			browserSessions: [],
			connectedMcpClients: [
				{
					id: "a".repeat(64),
					displayName: "Alice Codex",
					authorizedAt: 946_684_800_000,
					lastUsedAt: null,
					grantedScopes: ["yepnope:questions", "yepnope:afk"],
					status: "active",
					revokedAt: null,
				},
			],
			pushDevices: [{id: "push-alice", label: "Alice phone", createdAt: 946_684_800_000}],
		};
		fetchAccountDevices.mockImplementation(async () => Promise.resolve(accountDevices));
		revokePushDevice.mockImplementation(async () => {
			accountDevices = {...accountDevices, pushDevices: []};
			return Promise.resolve();
		});
		revokeConnectedMcpClient.mockImplementation(async () => {
			accountDevices = {...accountDevices, connectedMcpClients: []};
			return await Promise.resolve(0);
		});
		window.history.replaceState({}, "", "/settings");
		render(<App />);

		const clientRow = (await screen.findByText("Alice Codex")).closest("li");
		if (clientRow === null) {
			throw new Error("missing connected MCP client row");
		}
		expect([
			clientRow.textContent.includes("Not used yet"),
			clientRow.textContent.includes(
				"Granted scopes: Ask questions (yepnope:questions), Manage AFK routing (yepnope:afk)",
			),
		]).toStrictEqual([true, true]);
		expect(within(clientRow).queryByRole("button", {name: "Rename"})).toBeNull();

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

		fireEvent.click(within(clientRow).getByRole("button", {name: "Revoke"}));
		await waitFor(() => {
			expect(revokeConnectedMcpClient.mock.calls).toStrictEqual([["a".repeat(64)]]);
			expect(screen.getByText("No connected MCP clients.").textContent).toBe("No connected MCP clients.");
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
		fireEvent.click(await screen.findByRole("button", {name: "Sign in"}));
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
				connectedMcpClientCount: 1,
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
