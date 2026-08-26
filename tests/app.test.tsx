// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {
	AccountDevices,
	AuthenticationMethods,
	AuthenticationUser,
	CurrentDeckConnectionState,
	CurrentDeckStream,
	CurrentDeckStreamOptions,
	DeviceAuthorizationDecision,
	DeviceAuthorizationLookup,
	DeviceAuthorizationResult,
	LinkedAccount,
	LiveApplicationState,
	OAuthClientSummary,
	RegisteredPasskey,
	SocialProvider,
} from "../src/api";
import type {DeckQuestion, Disposition} from "../src/deck";

const streamedQuestions: DeckQuestion[] = [
	{
		questionId: "batch-alice:0",
		batchId: "batch-alice",
		project: "MCP test stream",
		repo: null,
		branch: null,
		worktree: null,
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

// Claude Code is the primary audience, so its commands ship next to the Codex ones and neither
// client is guessed at from the browser.
const CLAUDE_CODE_MARKETPLACE_COMMAND = "claude plugin marketplace add motlin/yepnope";
const CLAUDE_CODE_PLUGIN_COMMAND = "claude plugin install yepnope@yepnope";
const CLAUDE_CODE_ADD_COMMAND = "claude mcp add --scope local --transport http yepnope https://yepnope.app/mcp";
const CLAUDE_CODE_LOGIN_COMMAND = "/mcp";
const CODEX_MARKETPLACE_COMMAND = "codex plugin marketplace add motlin/yepnope";
const CODEX_PLUGIN_COMMAND = "codex plugin add yepnope@yepnope";
const CODEX_ADD_COMMAND = "codex mcp add yepnope --url https://yepnope.app/mcp";
const CODEX_LOGIN_COMMAND = "codex mcp login yepnope";
const SETUP_COMMANDS = [
	CLAUDE_CODE_MARKETPLACE_COMMAND,
	CLAUDE_CODE_PLUGIN_COMMAND,
	CLAUDE_CODE_ADD_COMMAND,
	CLAUDE_CODE_LOGIN_COMMAND,
	CODEX_MARKETPLACE_COMMAND,
	CODEX_PLUGIN_COMMAND,
	CODEX_ADD_COMMAND,
	CODEX_LOGIN_COMMAND,
];

function setupCommands(panel: HTMLElement): (string | null)[] {
	return Array.from(panel.querySelectorAll("code")).map((command) => command.textContent);
}

// §13.2 asks for the privacy position "plainly on the site". Settings are unreachable without an
// account, so every signed-out surface that asks the visitor for something repeats it verbatim.
const SIGNED_OUT_PRIVACY_COPY =
	"YepNope can read question bodies and answers. End-to-end encryption is not part of this MVP. " +
	"Question bodies and answers are deleted seven days after each batch is created. Signing in and " +
	"creating an account send this browser through a Cloudflare Turnstile check.";

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
const fetchDeviceAuthorization = vi.hoisted(() => vi.fn<(_userCode: string) => Promise<DeviceAuthorizationLookup>>());
const decideDeviceAuthorization = vi.hoisted(() =>
	vi.fn<(_userCode: string, _decision: DeviceAuthorizationDecision) => Promise<DeviceAuthorizationResult>>(),
);
const renamePushDevice = vi.hoisted(() => vi.fn<(_id: string, _label: string) => Promise<void>>());
const revokeConnectedMcpClient = vi.hoisted(() =>
	vi.fn<(_id: string) => Promise<number>>(async () => await Promise.resolve(0)),
);
const revokePushDevice = vi.hoisted(() => vi.fn<(_id: string) => Promise<void>>());

const fetchAuthenticationMethods = vi.hoisted(() =>
	vi.fn<() => Promise<AuthenticationMethods>>(async () =>
		Promise.resolve({
			emailPassword: true,
			magicLink: true,
			passkey: true,
			social: ["github", "google"],
			turnstileSiteKey: null,
		}),
	),
);
const sendMagicLink = vi.hoisted(() =>
	vi.fn<(_email: string, _humanVerificationToken: string | null, _callbackURL: string) => Promise<void>>(async () =>
		Promise.resolve(),
	),
);
const startSocialSignIn = vi.hoisted(() => vi.fn<(_provider: SocialProvider) => Promise<string>>());
const linkSocialAccount = vi.hoisted(() => vi.fn<(_provider: SocialProvider) => Promise<string>>());
const fetchLinkedAccounts = vi.hoisted(() => vi.fn<() => Promise<LinkedAccount[]>>(async () => Promise.resolve([])));
const unlinkAccount = vi.hoisted(() => vi.fn<(_accountId: string) => Promise<void>>(async () => Promise.resolve()));
const registerPasskey = vi.hoisted(() => vi.fn<(_name: string) => Promise<void>>(async () => Promise.resolve()));
const signInWithPasskey = vi.hoisted(() => vi.fn<() => Promise<AuthenticationUser>>());
const fetchPasskeys = vi.hoisted(() => vi.fn<() => Promise<RegisteredPasskey[]>>(async () => Promise.resolve([])));
const deletePasskey = vi.hoisted(() => vi.fn<(_id: string) => Promise<void>>(async () => Promise.resolve()));

const fetchAfk = vi.hoisted(() => vi.fn<() => Promise<boolean>>(async () => Promise.resolve(true)));
const updateAfk = vi.hoisted(() => vi.fn<(afk: boolean) => Promise<boolean>>(async (afk) => Promise.resolve(afk)));

// 🌗 jsdom ships no matchMedia, so the suite owns the system palette and can flip it mid-test.
let systemPrefersDark = false;
const schemeListeners = new Set<(event: MediaQueryListEvent) => void>();

function installMatchMedia(): void {
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		value: (query: string) => ({
			addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
				schemeListeners.add(listener);
			},
			matches: query === "(prefers-color-scheme: dark)" && systemPrefersDark,
			media: query,
			removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
				schemeListeners.delete(listener);
			},
		}),
	});
}

function changeSystemPalette(prefersDark: boolean): void {
	systemPrefersDark = prefersDark;
	act(() => {
		for (const listener of [...schemeListeners]) {
			listener({matches: prefersDark} as MediaQueryListEvent);
		}
	});
}

function paintedTheme(): {attribute: string | null; themeColor: string | null} {
	return {
		attribute: document.documentElement.getAttribute("data-theme"),
		themeColor: document.head.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null,
	};
}

function themeRadio(label: string): HTMLInputElement {
	return screen.getByRole<HTMLInputElement>("radio", {name: label});
}

let publishQuestions: ((questions: DeckQuestion[]) => void) | undefined;
let publishApplicationState: ((state: LiveApplicationState) => void) | undefined;
let expireSession: (() => void) | undefined;
const closeStream = vi.fn<() => void>();
const refreshStream = vi.fn<() => void>();

vi.mock("../src/api", () => ({
	ApiResponseError,
	SOCIAL_PROVIDER_LABELS: {github: "GitHub", google: "Google"},
	decideDeviceAuthorization,
	deletePasskey,
	fetchDeviceAuthorization,
	fetchAuthenticationMethods,
	fetchLinkedAccounts,
	fetchPasskeys,
	linkSocialAccount,
	registerPasskey,
	sendMagicLink,
	signInWithPasskey,
	startSocialSignIn,
	unlinkAccount,
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
import {THEME_CHOICES, THEME_STORAGE_KEY} from "../src/theme";

// 🤖 A signed-out form keeps its submit disabled until the Worker has said whether this deployment
// demands a human-verification check, so a test has to let that answer arrive before it clicks.
async function submitAccountForm(name: string): Promise<void> {
	const button = await screen.findByRole<HTMLButtonElement>("button", {name});
	await waitFor(() => {
		expect(button.disabled).toBe(false);
	});
	fireEvent.click(button);
}

beforeEach(() => {
	systemPrefersDark = false;
	schemeListeners.clear();
	installMatchMedia();
	document.documentElement.removeAttribute("data-theme");
	for (const meta of document.head.querySelectorAll('meta[name="theme-color"]')) {
		meta.remove();
	}
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
	fetchAuthenticationMethods.mockResolvedValue({
		emailPassword: true,
		magicLink: true,
		passkey: true,
		social: ["github", "google"],
		turnstileSiteKey: null,
	});
	fetchLinkedAccounts.mockResolvedValue([]);
	fetchPasskeys.mockResolvedValue([]);
	startSocialSignIn.mockReturnValue(new Promise<string>(() => {}));
	linkSocialAccount.mockReturnValue(new Promise<string>(() => {}));
	signInWithPasskey.mockReturnValue(new Promise<AuthenticationUser>(() => {}));
	Object.defineProperty(window, "PublicKeyCredential", {configurable: true, value: {}});
	fetchSession.mockResolvedValue(alice);
	fetchAccountDevices.mockResolvedValue({browserSessions: [], connectedMcpClients: [], pushDevices: []});
	renamePushDevice.mockResolvedValue(undefined);
	revokeConnectedMcpClient.mockResolvedValue(0);
	revokePushDevice.mockResolvedValue(undefined);
	fetchDeviceAuthorization.mockResolvedValue({
		status: "pending",
		authorization: {
			clientName: "Claude Code",
			scopes: ["openid", "offline_access", "yepnope:questions"],
			userCode: "WDJB-MJHT",
		},
	});
	decideDeviceAuthorization.mockResolvedValue({status: "decided", decision: "approved"});
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
			scope: "openid offline_access yepnope:questions",
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
		await submitAccountForm("Sign in");

		await waitFor(() => {
			expect(vi.mocked(signInForOAuthApi).mock.calls).toStrictEqual([
				["alice@example.com", "example-password", oauthQuery, null],
			]);
			expect(screen.getByRole("heading", {name: "Authorize MCP client"})).toBeDefined();
		});
	});

	// ✉️ An emailed link is a sign-in like any other, so it has to carry the pending authorization
	// the way the provider buttons beside it already do. A link that lands on the deck instead
	// leaves the visitor looking signed in while the MCP client that sent them waits forever.
	it("carries the authorization into an emailed sign-in link from the sign-in and recovery pages", async () => {
		const oauthQuery = new URLSearchParams({
			client_id: "oauth-client",
			resource: `${window.location.origin}/mcp`,
			scope: "openid offline_access yepnope:questions",
			sig: "signed-magic-link-authorization",
		}).toString();
		fetchSession.mockResolvedValue(null);
		window.history.replaceState({}, "", `/sign-in?${oauthQuery}`);

		render(<App />);

		fireEvent.change(await screen.findByRole("textbox", {name: "Email"}), {
			target: {value: "alice@example.com"},
		});
		await submitAccountForm("Email me a sign-in link");
		await waitFor(() => {
			expect(sendMagicLink.mock.calls).toStrictEqual([["alice@example.com", null, `/sign-in?${oauthQuery}`]]);
		});

		fireEvent.click(screen.getByRole("button", {name: "Forgot password?"}));
		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		await submitAccountForm("Email me a sign-in link");

		await waitFor(() => {
			expect(sendMagicLink.mock.calls).toStrictEqual([
				["alice@example.com", null, `/sign-in?${oauthQuery}`],
				["alice@example.com", null, `/sign-in?${oauthQuery}`],
			]);
		});
	});

	it("preserves OAuth through password reset and resumes at explicit consent after ordinary sign-in", async () => {
		const oauthQuery = new URLSearchParams({
			client_id: "oauth-client",
			resource: `${window.location.origin}/mcp`,
			scope: "openid offline_access yepnope:questions",
			sig: "signed-password-reset-authorization",
		}).toString();
		fetchSession.mockResolvedValue(null);
		resumeOAuthAuthorization.mockResolvedValue(`${window.location.origin}/oauth/consent?${oauthQuery}`);
		window.history.replaceState({}, "", `/oauth/consent?${oauthQuery}`);

		render(<App />);

		fireEvent.click(await screen.findByRole("button", {name: "Forgot password?"}));
		expect(`${window.location.pathname}${window.location.search}`).toBe(`/forgot-password?${oauthQuery}`);
		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		await submitAccountForm("Send recovery email");
		await waitFor(() => {
			expect(vi.mocked(requestPasswordReset).mock.calls).toStrictEqual([["alice@example.com", null]]);
		});

		window.history.pushState({}, "", "/reset-password?token=oauth-reset-token");
		fireEvent.popState(window);
		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		fireEvent.change(screen.getByLabelText("New password"), {target: {value: "replacement-password"}});
		await submitAccountForm("Save new password");

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
			signInCalls: [["alice@example.com", "replacement-password", null]],
			storedContinuation: null,
		});
	});

	it("says the authorization was stranded instead of dropping the signed-in user into a silent app", async () => {
		const oauthQuery = new URLSearchParams({
			client_id: "oauth-client",
			resource: `${window.location.origin}/mcp`,
			scope: "openid offline_access yepnope:questions",
			sig: "signed-authorization-request",
		}).toString();
		fetchSession.mockResolvedValue(alice);
		resumeOAuthAuthorization.mockRejectedValue(new Error("The authorization request has expired."));
		window.history.replaceState({}, "", `/sign-in?${oauthQuery}`);

		render(<App />);

		expect((await screen.findByRole("alert")).textContent).toBe(
			"We could not finish authorizing that MCP client. Start the connection again from the client.",
		);
		expect({
			deck: screen.getByRole("heading", {name: "All caught up"}).textContent,
			path: `${window.location.pathname}${window.location.search}`,
			resumeCalls: resumeOAuthAuthorization.mock.calls,
		}).toStrictEqual({
			deck: "All caught up",
			path: "/",
			resumeCalls: [[oauthQuery]],
		});

		fireEvent.click(screen.getByRole("button", {name: "Settings"}));
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("identifies the client, explains every scope, and offers explicit allow and cancel actions", async () => {
		const oauthQuery = new URLSearchParams({
			client_id: "oauth-client",
			resource: `${window.location.origin}/mcp`,
			scope: "openid offline_access yepnope:questions",
			sig: "signed-authorization-request",
		}).toString();
		window.history.replaceState({}, "", `/oauth/consent?${oauthQuery}`);

		render(<App />);

		expect(await screen.findByText("Codex")).toBeDefined();
		expect(
			["Use your YepNope identity", "Stay connected", "Ask questions"].map(
				(label) => screen.getByText(label).textContent,
			),
		).toStrictEqual(["Use your YepNope identity", "Stay connected", "Ask questions"]);
		expect(screen.getByRole("button", {name: "Allow"})).toBeDefined();
		fireEvent.click(screen.getByRole("button", {name: "Cancel"}));

		await waitFor(() => {
			expect(vi.mocked(submitOAuthConsentApi).mock.calls).toStrictEqual([[oauthQuery, false]]);
		});
	});

	it("hands the browser back to the client without delaying or rewriting the callback redirect", async () => {
		const callback = "http://127.0.0.1:57015/callback/4FAwZNJbSB0T?code=authorization-code&state=client-state";
		const oauthQuery = new URLSearchParams({
			client_id: "oauth-client",
			resource: `${window.location.origin}/mcp`,
			scope: "openid offline_access yepnope:questions",
			sig: "signed-authorization-request",
		}).toString();
		window.history.replaceState({}, "", `/oauth/consent?${oauthQuery}`);
		submitOAuthConsent.mockResolvedValue(callback);
		const assign = interceptNavigation();

		render(<App />);

		fireEvent.click(await screen.findByRole("button", {name: "Allow"}));

		const handoff = await screen.findByRole("status");
		expect({
			assignCalls: assign.mock.calls,
			consentCalls: vi.mocked(submitOAuthConsentApi).mock.calls,
			handoff: handoff.textContent,
			heading: screen.getByRole("heading", {level: 1}).textContent,
			remainingActions: [
				screen.queryByRole("button", {name: "Allow"}),
				screen.queryByRole("button", {name: "Cancel"}),
			],
		}).toStrictEqual({
			assignCalls: [[callback]],
			consentCalls: [[oauthQuery, true]],
			handoff:
				"YepNope sent your approval back to Codex." +
				"You can close this tab once Codex confirms the connection in your terminal.",
			heading: "Connection authorized",
			remainingActions: [null, null],
		});
	});

	it("states the declined outcome instead of a success handoff", async () => {
		const callback = "http://127.0.0.1:57015/callback/4FAwZNJbSB0T?error=access_denied&state=client-state";
		const oauthQuery = new URLSearchParams({
			client_id: "oauth-client",
			resource: `${window.location.origin}/mcp`,
			scope: "openid offline_access yepnope:questions",
			sig: "signed-authorization-request",
		}).toString();
		window.history.replaceState({}, "", `/oauth/consent?${oauthQuery}`);
		submitOAuthConsent.mockResolvedValue(callback);
		const assign = interceptNavigation();

		render(<App />);

		fireEvent.click(await screen.findByRole("button", {name: "Cancel"}));

		const handoff = await screen.findByRole("status");
		expect({
			assignCalls: assign.mock.calls,
			handoff: handoff.textContent,
			heading: screen.getByRole("heading", {level: 1}).textContent,
		}).toStrictEqual({
			assignCalls: [[callback]],
			handoff:
				"YepNope told Codex you declined the connection." +
				"You can close this tab and go back to your terminal.",
			heading: "Connection declined",
		});
	});

	it("keeps the authorization surface when the request continues on YepNope", async () => {
		const oauthQuery = new URLSearchParams({
			client_id: "oauth-client",
			resource: `${window.location.origin}/mcp`,
			scope: "openid offline_access yepnope:questions",
			sig: "signed-authorization-request",
		}).toString();
		window.history.replaceState({}, "", `/oauth/consent?${oauthQuery}`);
		submitOAuthConsent.mockResolvedValue(`/oauth/consent?${oauthQuery}&prompt=consent`);
		const assign = interceptNavigation();

		render(<App />);

		fireEvent.click(await screen.findByRole("button", {name: "Allow"}));

		await waitFor(() => {
			expect(window.location.search).toBe(`?${oauthQuery}&prompt=consent`);
		});
		expect({
			assignCalls: assign.mock.calls,
			handoff: screen.queryByRole("status"),
			heading: screen.getByRole("heading", {level: 1}).textContent,
		}).toStrictEqual({assignCalls: [], handoff: null, heading: "Authorize MCP client"});
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

describe("Device authorization", () => {
	it("looks up the code from the link and names the client and what it may do", async () => {
		window.history.replaceState({}, "", "/device?user_code=WDJB-MJHT");

		render(<App />);

		expect(await screen.findByText("Claude Code")).toBeDefined();
		expect({
			capabilities: [...document.querySelectorAll(".oauth-capabilities strong")].map(
				(capability) => capability.textContent,
			),
			lookupCalls: fetchDeviceAuthorization.mock.calls,
			userCode: screen.getByText("WDJB-MJHT").textContent,
		}).toStrictEqual({
			capabilities: ["Use your YepNope identity", "Stay connected", "Ask questions"],
			lookupCalls: [["WDJB-MJHT"]],
			userCode: "WDJB-MJHT",
		});
	});

	it("approves the waiting terminal and sends the visitor back to it", async () => {
		window.history.replaceState({}, "", "/device?user_code=WDJB-MJHT");

		render(<App />);

		fireEvent.click(await screen.findByRole("button", {name: "Approve"}));

		const outcome = await screen.findByRole("status");
		expect({
			decideCalls: decideDeviceAuthorization.mock.calls,
			heading: screen.getByRole("heading", {level: 1}).textContent,
			outcome: outcome.textContent,
			remainingActions: [
				screen.queryByRole("button", {name: "Approve"}),
				screen.queryByRole("button", {name: "Deny"}),
			],
		}).toStrictEqual({
			decideCalls: [["WDJB-MJHT", "approved"]],
			heading: "Device approved",
			outcome:
				"Approved. You can go back to your terminal." +
				"You can revoke it any time under Settings, Connected MCP clients.",
			remainingActions: [null, null],
		});
	});

	it("states the denied outcome instead of a success handoff", async () => {
		window.history.replaceState({}, "", "/device?user_code=WDJB-MJHT");
		decideDeviceAuthorization.mockResolvedValue({status: "decided", decision: "denied"});

		render(<App />);

		fireEvent.click(await screen.findByRole("button", {name: "Deny"}));

		const outcome = await screen.findByRole("status");
		expect({
			decideCalls: decideDeviceAuthorization.mock.calls,
			heading: screen.getByRole("heading", {level: 1}).textContent,
			outcome: outcome.textContent,
		}).toStrictEqual({
			decideCalls: [["WDJB-MJHT", "denied"]],
			heading: "Device denied",
			outcome:
				"Denied. Nothing was connected to your account." +
				"You can close this tab and go back to your terminal.",
		});
	});

	it("names each dead end the code can already be in", async () => {
		for (const {heading, lookup, outcome} of [
			{
				heading: "Code expired",
				lookup: {status: "expired"} as const,
				outcome: "This code has expired.Codes last ten minutes. Run the command again to get a fresh one.",
			},
			{
				heading: "Code not found",
				lookup: {status: "not_found"} as const,
				outcome:
					"No pending request matches that code." +
					"Check the code your terminal printed, or run the command again to get a fresh one.",
			},
			{
				heading: "Code already used",
				lookup: {status: "decided"} as const,
				outcome:
					"This code was already approved or denied." + "Run the command again if you still need to connect.",
			},
		]) {
			window.history.replaceState({}, "", "/device?user_code=WDJB-MJHT");
			fetchDeviceAuthorization.mockResolvedValue(lookup);

			render(<App />);

			expect((await screen.findByRole("status")).textContent).toBe(outcome);
			expect(screen.getByRole("heading", {level: 1}).textContent).toBe(heading);
			expect(screen.queryByRole("button", {name: "Approve"})).toBeNull();
			cleanup();
		}
	});

	it("asks for the code when the visitor arrives without one", async () => {
		window.history.replaceState({}, "", "/device");

		render(<App />);

		fireEvent.change(await screen.findByRole("textbox", {name: "Device code"}), {target: {value: "wdjb mjht"}});
		fireEvent.click(screen.getByRole("button", {name: "Continue"}));

		expect(await screen.findByText("Claude Code")).toBeDefined();
		// The server owns case and dash normalization, so the page forwards what was typed.
		expect(fetchDeviceAuthorization.mock.calls).toStrictEqual([["wdjb mjht"]]);
	});

	it("routes a signed-out visitor through sign-in and back with the code intact", async () => {
		fetchSession.mockResolvedValueOnce(null).mockResolvedValue(alice);
		window.history.replaceState({}, "", "/device?user_code=WDJB-MJHT");

		render(<App />);

		expect(await screen.findByRole("heading", {name: "Sign in"})).toBeDefined();
		expect(`${window.location.pathname}${window.location.search}`).toBe("/sign-in?user_code=WDJB-MJHT");
		expect(fetchDeviceAuthorization.mock.calls).toStrictEqual([]);
		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		fireEvent.change(screen.getByLabelText("Password"), {target: {value: "example-password"}});
		await submitAccountForm("Sign in");

		expect(await screen.findByText("Claude Code")).toBeDefined();
		expect(`${window.location.pathname}${window.location.search}`).toBe("/device?user_code=WDJB-MJHT");
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
		fireEvent.click(screen.getByRole("button", {name: "Connect Claude Code or Codex"}));
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

	it("shows only the AFK toggle and settings control for an authorized client", async () => {
		render(<App />);
		await waitFor(() => {
			expect(publishQuestions).toBeTypeOf("function");
		});
		act(() => {
			publishQuestions?.([]);
		});

		expect({
			accountStatuses: document.querySelectorAll(".app-header .account-status").length,
			buttons: [...document.querySelectorAll(".app-header button")].map((button) => ({
				accessibleName: button.getAttribute("aria-label") ?? button.textContent,
				className: button.className,
			})),
		}).toStrictEqual({
			accountStatuses: 0,
			buttons: [
				{accessibleName: "AFK on", className: "afk-toggle afk-on"},
				{accessibleName: "Settings", className: "settings-button"},
			],
		});
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
		expect(setupCommands(screen.getByRole("region", {name: "Connected MCP clients"}))).toStrictEqual(
			SETUP_COMMANDS,
		);
		expect(document.body.textContent.toLowerCase()).not.toContain("pair");
	});

	it("sends the AFK empty state straight to the per-client instructions", async () => {
		fetchAccountDevices.mockResolvedValue({browserSessions: [], connectedMcpClients: [], pushDevices: []});
		render(<App />);
		await waitFor(() => {
			expect(publishApplicationState).toBeTypeOf("function");
		});
		act(() => {
			publishApplicationState?.({afk: false, connectedMcpClientCount: 0, currentDeck: []});
		});

		fireEvent.click(screen.getByRole("button", {name: "Connect Claude Code or Codex"}));

		const panel = await screen.findByRole("region", {name: "Connected MCP clients"});
		const heading = within(panel).getByRole("heading", {name: "Connected MCP clients"});
		expect({
			focused: document.activeElement === heading,
			commands: setupCommands(panel),
		}).toStrictEqual({
			focused: true,
			commands: SETUP_COMMANDS,
		});
	});

	it("documents setup for every supported client instead of Codex alone", async () => {
		render(<App />);
		await waitFor(() => {
			expect(publishQuestions).toBeTypeOf("function");
		});
		act(() => {
			publishQuestions?.([]);
		});
		fireEvent.click(screen.getByRole("button", {name: "Settings"}));

		const panel = screen.getByRole("region", {name: "Connected MCP clients"});
		expect({
			clients: within(panel)
				.getAllByRole("heading", {level: 4})
				.map((heading) => heading.textContent),
			commands: setupCommands(panel),
			docsUrls: within(panel)
				.getAllByRole("link")
				.map((link) => link.getAttribute("href")),
		}).toStrictEqual({
			clients: ["Claude Code", "Codex"],
			commands: SETUP_COMMANDS,
			docsUrls: ["https://docs.claude.com/en/docs/claude-code/mcp", "https://developers.openai.com/codex/mcp/"],
		});
	});

	it("copies the setup command of whichever client the reader picks", async () => {
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
		const panel = screen.getByRole("region", {name: "Connected MCP clients"});
		const copyButtons = within(panel).getAllByRole("button", {name: "Copy"});
		fireEvent.click(copyButtons[0] ?? document.body);
		fireEvent.click(copyButtons[4] ?? document.body);
		await waitFor(() => {
			expect(writeText.mock.calls).toStrictEqual([
				[CLAUDE_CODE_MARKETPLACE_COMMAND],
				[CODEX_MARKETPLACE_COMMAND],
			]);
		});
		expect({
			copyButtons: copyButtons.length,
			claudeCodeCommand: screen.getByText(CLAUDE_CODE_MARKETPLACE_COMMAND).tagName,
			codexCommand: screen.getByText(CODEX_MARKETPLACE_COMMAND).tagName,
			copiedButtons: within(panel).getAllByRole("button", {name: "Copied"}).length,
		}).toStrictEqual({
			copyButtons: SETUP_COMMANDS.length,
			claudeCodeCommand: "CODE",
			codexCommand: "CODE",
			copiedButtons: 2,
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
			command: screen.getByText(CLAUDE_CODE_MARKETPLACE_COMMAND).textContent,
		}).toStrictEqual({
			copyCalls: [[CLAUDE_CODE_MARKETPLACE_COMMAND]],
			command: CLAUDE_CODE_MARKETPLACE_COMMAND,
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
				"YepNopeSign in to answer questions from your coding agents, or create an account to get started." +
				SIGNED_OUT_PRIVACY_COPY +
				"Sign inCreate account",
			authenticatedShell: 0,
			openedStream: false,
			settingsControls: 0,
			storedCredentials: [],
		});
	});

	it("repeats the privacy position on the sign-in and account-creation surfaces", async () => {
		fetchSession.mockResolvedValue(null);
		const {container} = render(<App />);

		fireEvent.click(await screen.findByRole("button", {name: "Sign in"}));
		const signIn = [...container.querySelectorAll(".signed-out-privacy")].map((note) => note.textContent);
		fireEvent.click(screen.getByRole("button", {name: "Create an account"}));
		const register = [...container.querySelectorAll(".signed-out-privacy")].map((note) => note.textContent);

		expect({register, signIn}).toStrictEqual({
			register: [SIGNED_OUT_PRIVACY_COPY],
			signIn: [SIGNED_OUT_PRIVACY_COPY],
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
		await submitAccountForm("Sign in");
		expect((await screen.findByRole("alert")).textContent).toBe(
			"Sign-in failed. Check your email and password, or recover your account.",
		);
		fireEvent.click(screen.getByRole("button", {name: "Back to YepNope"}));
		expect({
			actions: screen.getAllByRole("button").map((button) => button.textContent),
			authenticatedShell: container.querySelectorAll(".app-header, .deck, .settings").length,
			pathname: window.location.pathname,
		}).toStrictEqual({actions: ["Sign in", "Create account"], authenticatedShell: 0, pathname: "/"});

		await submitAccountForm("Create account");
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
		await submitAccountForm("Create account");

		expect(await screen.findByRole("heading", {name: "Verify your email"})).toBeDefined();
		expect(vi.mocked(registerAccount).mock.calls).toStrictEqual([
			["alice@example.com", "example-password", null, "/verify-email"],
		]);
		expect(vi.mocked(sendVerificationEmail).mock.calls).toStrictEqual([
			["alice@example.com", null, "/verify-email"],
		]);
		// The resend is held back until the Worker has answered whether a human-verification check
		// is required, so the settled page is what this snapshot is of.
		await waitFor(() => {
			expect(screen.getByRole<HTMLButtonElement>("button", {name: "Resend verification email"}).disabled).toBe(
				false,
			);
		});
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
				"If verification is available for that address, the emailed link finishes creating your account. Delivery can take a few minutes, and the message can land in spam.",
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
			instruction:
				"If verification is available for that address, the emailed link finishes creating your account. Delivery can take a few minutes, and the message can land in spam.",
			status: null,
		});
		let finishResend: () => void = () => undefined;
		vi.mocked(sendVerificationEmail).mockReturnValueOnce(
			new Promise<void>((resolve) => {
				finishResend = resolve;
			}),
		);
		await submitAccountForm("Resend verification email");
		const sendingButton = screen.getByRole("button", {name: "Sending…"});
		expect({
			ariaBusy: sendingButton.getAttribute("aria-busy"),
			disabled: (sendingButton as HTMLButtonElement).disabled,
		}).toStrictEqual({ariaBusy: "true", disabled: true});
		finishResend();
		await waitFor(() => {
			expect(vi.mocked(sendVerificationEmail).mock.calls).toStrictEqual([
				["alice@example.com", null, "/verify-email"],
				["alice@example.com", null, "/verify-email"],
			]);
			expect(screen.getByRole("status").textContent).toBe(
				"Verification was requested. If a link is available for that address, it can take a few minutes to arrive, so check your spam folder too.",
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
		await submitAccountForm("Create account");

		expect(await screen.findByRole("heading", {name: "Verify your email"})).toBeDefined();
		expect(screen.getByRole("alert").textContent).toBe("We couldn't submit that request. Try again.");
		expect(vi.mocked(registerAccount).mock.calls).toStrictEqual([
			["alice@example.com", "example-password", null, "/verify-email"],
		]);
		expect(vi.mocked(sendVerificationEmail).mock.calls).toStrictEqual([
			["alice@example.com", null, "/verify-email"],
		]);
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
		await submitAccountForm("Send recovery email");
		await waitFor(() => {
			expect(vi.mocked(requestPasswordReset).mock.calls).toStrictEqual([["alice@example.com", null]]);
			expect(screen.getByRole("status").textContent).toBe(
				"If recovery is available for that address, check its inbox for next steps.",
			);
		});

		rendered.unmount();
		window.history.replaceState({}, "", "/reset-password?token=test-recovery-token");
		render(<App />);
		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		fireEvent.change(screen.getByLabelText("New password"), {target: {value: "replacement-password"}});
		await submitAccountForm("Save new password");

		await waitFor(() => {
			expect(vi.mocked(consumePasswordResetToken).mock.calls).toStrictEqual([
				["test-recovery-token", "replacement-password"],
			]);
			expect(vi.mocked(signIn).mock.calls).toStrictEqual([["alice@example.com", "replacement-password", null]]);
			expect(window.location.pathname).toBe("/settings");
		});
	});

	// 🔑 An account created with an emailed link or a passkey has no password, so a recovery page
	// that only resets one asks that owner to invent a credential they never wanted. The link that
	// signs them straight back in is offered on the same page, drawing on the same typed address.
	it("emails a sign-in link from the recovery page for an account with no password", async () => {
		fetchSession.mockResolvedValue(null);
		window.history.replaceState({}, "", "/forgot-password");
		render(<App />);

		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		await submitAccountForm("Email me a sign-in link");

		await waitFor(() => {
			expect(sendMagicLink.mock.calls).toStrictEqual([["alice@example.com", null, "/"]]);
		});
		expect((await screen.findByRole("status")).textContent).toBe(
			"If the request can be completed, check your inbox for a sign-in link. It expires in 15 minutes.",
		);
		expect(vi.mocked(requestPasswordReset)).not.toHaveBeenCalled();
	});

	it("never retries a consumed reset token when the follow-up sign-in fails", async () => {
		fetchSession.mockResolvedValue(null);
		vi.mocked(signIn).mockRejectedValueOnce(new Error("Sign-in temporarily unavailable"));
		window.history.replaceState({}, "", "/reset-password?token=single-use-reset-token");
		render(<App />);

		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alic@example.com"}});
		fireEvent.change(screen.getByLabelText("New password"), {target: {value: "replacement-password"}});
		await submitAccountForm("Save new password");

		expect((await screen.findByRole("alert")).textContent).toBe("Sign-in temporarily unavailable");
		expect({
			path: `${window.location.pathname}${window.location.search}`,
			resetCalls: vi.mocked(consumePasswordResetToken).mock.calls,
			signInCalls: vi.mocked(signIn).mock.calls,
			status: screen.getByRole("status").textContent,
		}).toStrictEqual({
			path: "/reset-password",
			resetCalls: [["single-use-reset-token", "replacement-password"]],
			signInCalls: [["alic@example.com", "replacement-password", null]],
			status: "Your password has been changed.",
		});

		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		await submitAccountForm("Try signing in again");
		await waitFor(() => {
			expect(window.location.pathname).toBe("/settings");
		});
		expect({
			resetCalls: vi.mocked(consumePasswordResetToken).mock.calls,
			signInCalls: vi.mocked(signIn).mock.calls,
		}).toStrictEqual({
			resetCalls: [["single-use-reset-token", "replacement-password"]],
			signInCalls: [
				["alic@example.com", "replacement-password", null],
				["alice@example.com", "replacement-password", null],
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
		await submitAccountForm("Save new password");

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
					grantedScopes: ["yepnope:questions"],
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
			clientRow.textContent.includes("Granted scopes: Ask questions (yepnope:questions)"),
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
		await submitAccountForm("Sign in");
		await waitFor(() => {
			expect(vi.mocked(signIn).mock.calls).toStrictEqual([["alice@example.com", "example-password", null]]);
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

// jsdom's `location.assign` is non-configurable, so swap in a live-reading stand-in for the test.
const LIVE_LOCATION_PROPERTIES = [
	"hash",
	"host",
	"hostname",
	"href",
	"origin",
	"pathname",
	"port",
	"protocol",
	"search",
];

function interceptNavigation(): ReturnType<typeof vi.fn> {
	const assign = vi.fn<(_url: string) => void>();
	const original = window.location;
	const stub: Record<string, unknown> = {assign, reload: vi.fn<() => void>(), replace: assign};
	for (const property of LIVE_LOCATION_PROPERTIES) {
		Object.defineProperty(stub, property, {
			enumerable: true,
			get: () => Reflect.get(original, property) as unknown,
		});
	}
	Object.defineProperty(window, "location", {configurable: true, value: stub});
	navigationRestores.push(() => {
		Object.defineProperty(window, "location", {configurable: true, value: original});
	});
	return assign;
}

const navigationRestores: Array<() => void> = [];

afterEach(() => {
	for (const restore of navigationRestores.splice(0)) {
		restore();
	}
});

describe("Alternative sign-in methods", () => {
	async function renderSignIn(): Promise<void> {
		fetchSession.mockResolvedValue(null);
		window.history.replaceState({}, "", "/sign-in");
		render(<App />);
		await waitFor(() => {
			expect(fetchAuthenticationMethods).toHaveBeenCalled();
		});
	}

	it("offers only the providers this deployment configured", async () => {
		fetchAuthenticationMethods.mockResolvedValue({
			emailPassword: true,
			magicLink: true,
			passkey: true,
			social: ["github"],
			turnstileSiteKey: null,
		});
		await renderSignIn();

		expect(await screen.findByRole("button", {name: "Continue with GitHub"})).toBeDefined();
		expect(screen.queryByRole("button", {name: "Continue with Google"})).toBeNull();
	});

	it("sends the browser to the provider once its button is pressed", async () => {
		const assign = interceptNavigation();
		startSocialSignIn.mockResolvedValue("https://github.com/login/oauth/authorize?state=abc");
		await renderSignIn();

		fireEvent.click(await screen.findByRole("button", {name: "Continue with GitHub"}));

		await waitFor(() => {
			expect(startSocialSignIn.mock.calls).toStrictEqual([["github", "/"]]);
			expect(assign.mock.calls).toStrictEqual([["https://github.com/login/oauth/authorize?state=abc"]]);
		});
	});

	it("emails a sign-in link to the address already typed", async () => {
		await renderSignIn();

		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		await submitAccountForm("Email me a sign-in link");

		await waitFor(() => {
			expect(sendMagicLink.mock.calls).toStrictEqual([["alice@example.com", null, "/"]]);
		});
		expect((await screen.findByRole("status")).textContent).toBe(
			"If the request can be completed, check your inbox for a sign-in link. It expires in 15 minutes.",
		);
	});

	it("asks for an address before requesting a sign-in link", async () => {
		await renderSignIn();

		await submitAccountForm("Email me a sign-in link");

		expect((await screen.findByRole("alert")).textContent).toBe("Enter your email address first.");
		expect(sendMagicLink).not.toHaveBeenCalled();
	});

	it("signs in with a passkey and lands where a password sign-in lands", async () => {
		signInWithPasskey.mockResolvedValue(alice);
		await renderSignIn();

		fireEvent.click(await screen.findByRole("button", {name: "Sign in with a passkey"}));

		await waitFor(() => {
			expect(window.location.pathname).toBe("/settings");
		});
	});

	it("stays on the sign-in route when the passkey ceremony is cancelled", async () => {
		signInWithPasskey.mockRejectedValue(new Error("Passkey sign-in was cancelled."));
		await renderSignIn();

		fireEvent.click(await screen.findByRole("button", {name: "Sign in with a passkey"}));

		expect((await screen.findByRole("alert")).textContent).toBe("Passkey sign-in was cancelled.");
		expect(window.location.pathname).toBe("/sign-in");
	});

	it("hides passkey sign-in on a browser without WebAuthn", async () => {
		Reflect.deleteProperty(window, "PublicKeyCredential");
		await renderSignIn();

		await screen.findByRole("button", {name: "Continue with GitHub"});
		expect(screen.queryByRole("button", {name: "Sign in with a passkey"})).toBeNull();
	});

	it("explains a provider redirect that came back as an error", async () => {
		fetchSession.mockResolvedValue(null);
		window.history.replaceState({}, "", "/sign-in?error=account_not_linked");
		render(<App />);

		expect((await screen.findByRole("alert")).textContent).toBe(
			"Sign-in through that provider did not complete. Sign in another way, then connect it from Settings.",
		);
	});

	it("keeps the sign-in page usable when method discovery fails", async () => {
		fetchAuthenticationMethods.mockRejectedValue(new Error("offline"));
		await renderSignIn();

		expect(screen.getByRole("textbox", {name: "Email"})).toBeDefined();
		expect(screen.getByRole("button", {name: "Sign in"})).toBeDefined();
		expect(screen.queryByRole("button", {name: "Continue with GitHub"})).toBeNull();
	});
});

describe("Sign-in method management", () => {
	async function renderSettings(): Promise<void> {
		window.history.replaceState({}, "", "/settings");
		render(<App />);
		await waitFor(() => {
			expect(fetchPasskeys).toHaveBeenCalled();
		});
	}

	it("lists connected providers and registered passkeys", async () => {
		fetchLinkedAccounts.mockResolvedValue([
			{id: "account-credential", provider: "credential"},
			{id: "account-github", provider: "github"},
		]);
		fetchPasskeys.mockResolvedValue([{id: "passkey-phone", name: "Alice phone", createdAt: 946_684_800_000}]);
		await renderSettings();

		const section = await screen.findByRole("region", {name: "Sign-in methods"});
		expect(within(section).getByRole("button", {name: "Disconnect GitHub"})).toBeDefined();
		expect(within(section).getByRole("button", {name: "Connect Google"})).toBeDefined();
		expect(within(section).getByText("Alice phone")).toBeDefined();
	});

	it("connects a provider through the same redirect the browser already trusts", async () => {
		const assign = interceptNavigation();
		linkSocialAccount.mockResolvedValue("https://accounts.google.com/o/oauth2/auth?state=abc");
		await renderSettings();

		fireEvent.click(await screen.findByRole("button", {name: "Connect Google"}));

		await waitFor(() => {
			expect(linkSocialAccount.mock.calls).toStrictEqual([["google", "/settings"]]);
			expect(assign.mock.calls).toStrictEqual([["https://accounts.google.com/o/oauth2/auth?state=abc"]]);
		});
	});

	it("registers a new passkey and reloads the list", async () => {
		await renderSettings();

		fireEvent.click(await screen.findByRole("button", {name: "Add a passkey"}));

		await waitFor(() => {
			expect(registerPasskey.mock.calls.length).toBe(1);
			expect(fetchPasskeys.mock.calls.length).toBeGreaterThan(1);
		});
	});

	it("removes a passkey", async () => {
		fetchPasskeys.mockResolvedValue([{id: "passkey-phone", name: "Alice phone", createdAt: 946_684_800_000}]);
		await renderSettings();

		const passkeyRow = within(await screen.findByRole("region", {name: "Sign-in methods"})).getByRole("listitem");
		fireEvent.click(within(passkeyRow).getByRole("button", {name: "Remove"}));

		await waitFor(() => {
			expect(deletePasskey.mock.calls).toStrictEqual([["passkey-phone"]]);
		});
	});

	it("shows why the last remaining sign-in method cannot be disconnected", async () => {
		fetchLinkedAccounts.mockResolvedValue([{id: "account-github", provider: "github"}]);
		unlinkAccount.mockRejectedValue(new ApiResponseError("You can't unlink your last account", 400));
		await renderSettings();

		fireEvent.click(await screen.findByRole("button", {name: "Disconnect GitHub"}));

		expect((await screen.findByRole("alert")).textContent).toBe("You can't unlink your last account");
	});
});

// 🤖 The same forms on a deployment that does demand a human-verification check. The widget script
// is stubbed, so what is under test is the wiring: which token reaches which request, and what the
// page does before it has one.
describe("Gated public authentication", () => {
	const TEST_SITE_KEY = "1x00000000000000000000AA";

	interface RenderedWidget {
		action: string;
		callback: (token: string) => void;
		"error-callback": () => void;
	}

	function installTurnstileStub(): {solve: (token: string) => void; widgets: RenderedWidget[]} {
		const widgets: RenderedWidget[] = [];
		let counter = 0;
		window.turnstile = {
			remove: () => undefined,
			render: (container, options) => {
				counter += 1;
				container.append(document.createElement("div"));
				widgets.push(options);
				return `widget-${counter}`;
			},
			reset: () => undefined,
		};
		return {
			solve: (token) => {
				const widget = widgets.at(-1);
				if (widget === undefined) {
					throw new Error("the widget was never rendered");
				}
				act(() => {
					widget.callback(token);
				});
			},
			widgets,
		};
	}

	async function renderGated(path: string): Promise<{solve: (token: string) => void; widgets: RenderedWidget[]}> {
		fetchSession.mockResolvedValue(null);
		fetchAuthenticationMethods.mockResolvedValue({
			emailPassword: true,
			magicLink: true,
			passkey: false,
			social: [],
			turnstileSiteKey: TEST_SITE_KEY,
		});
		const turnstile = installTurnstileStub();
		window.history.replaceState({}, "", path);
		render(<App />);
		await waitFor(() => {
			expect(turnstile.widgets.length).toBeGreaterThan(0);
		});
		return turnstile;
	}

	afterEach(() => {
		delete window.turnstile;
	});

	it("sends the sign-in surface's own token with the credentials", async () => {
		const turnstile = await renderGated("/sign-in");
		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		fireEvent.change(screen.getByLabelText("Password"), {target: {value: "example-password"}});
		turnstile.solve("sign-in-token");

		await submitAccountForm("Sign in");

		await waitFor(() => {
			expect(vi.mocked(signIn).mock.calls).toStrictEqual([
				["alice@example.com", "example-password", "sign-in-token"],
			]);
		});
		expect(turnstile.widgets.map((widget) => widget.action)).toStrictEqual(["sign_in"]);
	});

	it("sends the sign-in page's token with an emailed sign-in link too", async () => {
		const turnstile = await renderGated("/sign-in");
		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		turnstile.solve("magic-link-token");

		await submitAccountForm("Email me a sign-in link");

		await waitFor(() => {
			expect(sendMagicLink.mock.calls).toStrictEqual([["alice@example.com", "magic-link-token", "/"]]);
		});
	});

	// 🎟️ Creating an account is two requests, and one token cannot pay for both.
	it("spends a fresh token on each of the two requests creating an account makes", async () => {
		const turnstile = await renderGated("/register");
		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		fireEvent.change(screen.getByLabelText("Password"), {target: {value: "example-password"}});
		turnstile.solve("register-token");

		await submitAccountForm("Create account");

		await waitFor(() => {
			expect(vi.mocked(registerAccount).mock.calls).toStrictEqual([
				["alice@example.com", "example-password", "register-token", "/verify-email"],
			]);
		});
		turnstile.solve("verification-token");
		await waitFor(() => {
			expect(vi.mocked(sendVerificationEmail).mock.calls).toStrictEqual([
				["alice@example.com", "verification-token", "/verify-email"],
			]);
		});
	});

	it("names the password-recovery surface in the token that requests it", async () => {
		const turnstile = await renderGated("/forgot-password");
		fireEvent.change(screen.getByRole("textbox", {name: "Email"}), {target: {value: "alice@example.com"}});
		turnstile.solve("recovery-token");

		await submitAccountForm("Send recovery email");

		await waitFor(() => {
			expect(vi.mocked(requestPasswordReset).mock.calls).toStrictEqual([["alice@example.com", "recovery-token"]]);
		});
		expect(turnstile.widgets.map((widget) => widget.action)).toStrictEqual(["reset_password"]);
	});

	it("holds every submission back while the check is still running", async () => {
		await renderGated("/sign-in");

		expect({
			signIn: screen.getByRole<HTMLButtonElement>("button", {name: "Sign in"}).disabled,
			magicLink: screen.getByRole<HTMLButtonElement>("button", {name: "Email me a sign-in link"}).disabled,
			signInCalls: vi.mocked(signIn).mock.calls.length,
		}).toStrictEqual({signIn: true, magicLink: true, signInCalls: 0});
	});

	// A page that cannot learn whether a check is required cannot submit anything either, so it
	// says why instead of letting the Worker answer with a refusal the visitor cannot act on.
	it("explains itself when the deployment's requirements cannot be read", async () => {
		fetchSession.mockResolvedValue(null);
		fetchAuthenticationMethods.mockRejectedValue(new Error("offline"));
		window.history.replaceState({}, "", "/sign-in");
		render(<App />);

		expect((await screen.findByRole("alert")).textContent).toBe(
			"We could not reach YepNope to set this page up. Check your connection and reload.",
		);
		expect(screen.getByRole<HTMLButtonElement>("button", {name: "Sign in"}).disabled).toBe(true);
	});
});

// 🌗 Light, dark, and follow-system. Follow-system is the default and stays live; an explicit
// choice outranks the system in both directions and survives a reload of this browser.
describe("Theme", () => {
	async function openAppearance(): Promise<void> {
		window.history.replaceState({}, "", "/settings");
		render(<App />);
		await screen.findByRole("region", {name: "Appearance"});
	}

	it("follows the system palette until something is chosen", async () => {
		systemPrefersDark = true;
		await openAppearance();

		expect({
			...paintedTheme(),
			checked: THEME_CHOICES.filter((choice) => themeRadio(choice.label).checked).map((choice) => choice.label),
			stored: window.localStorage.getItem(THEME_STORAGE_KEY),
		}).toStrictEqual({
			attribute: null,
			checked: ["Match system"],
			stored: null,
			themeColor: "#17181c",
		});
	});

	it("repaints without a reload when the system palette changes underneath it", async () => {
		await openAppearance();
		expect(paintedTheme()).toStrictEqual({attribute: null, themeColor: "#f1f2f4"});

		changeSystemPalette(true);

		expect({...paintedTheme(), checked: themeRadio("Match system").checked}).toStrictEqual({
			attribute: null,
			checked: true,
			themeColor: "#17181c",
		});
	});

	it("lets an explicit choice outrank the system palette in both directions", async () => {
		systemPrefersDark = true;
		await openAppearance();

		fireEvent.click(themeRadio("Light"));
		expect({...paintedTheme(), stored: window.localStorage.getItem(THEME_STORAGE_KEY)}).toStrictEqual({
			attribute: "light",
			stored: "light",
			themeColor: "#f1f2f4",
		});

		changeSystemPalette(false);
		fireEvent.click(themeRadio("Dark"));
		expect({...paintedTheme(), stored: window.localStorage.getItem(THEME_STORAGE_KEY)}).toStrictEqual({
			attribute: "dark",
			stored: "dark",
			themeColor: "#17181c",
		});

		// The system is light and moves; the explicit dark choice ignores it.
		changeSystemPalette(true);
		changeSystemPalette(false);
		expect(paintedTheme()).toStrictEqual({attribute: "dark", themeColor: "#17181c"});
	});

	it("hands the choice back after a reload, and lets it be given back to the system", async () => {
		await openAppearance();
		fireEvent.click(themeRadio("Dark"));
		cleanup();
		document.documentElement.removeAttribute("data-theme");

		await openAppearance();
		expect({
			...paintedTheme(),
			checked: THEME_CHOICES.filter((choice) => themeRadio(choice.label).checked).map((choice) => choice.label),
		}).toStrictEqual({attribute: "dark", checked: ["Dark"], themeColor: "#17181c"});

		fireEvent.click(themeRadio("Match system"));
		expect({...paintedTheme(), stored: window.localStorage.getItem(THEME_STORAGE_KEY)}).toStrictEqual({
			attribute: null,
			stored: "system",
			themeColor: "#f1f2f4",
		});

		changeSystemPalette(true);
		expect(paintedTheme()).toStrictEqual({attribute: null, themeColor: "#17181c"});
	});

	it("paints the signed-out pages and their verification widget in the same palette", async () => {
		const widgetThemes: string[] = [];
		window.turnstile = {
			remove: () => undefined,
			render: (container, options) => {
				container.append(document.createElement("div"));
				widgetThemes.push(options.theme);
				return "widget-1";
			},
			reset: () => undefined,
		};
		window.localStorage.setItem(THEME_STORAGE_KEY, "light");
		systemPrefersDark = true;
		fetchSession.mockResolvedValue(null);
		fetchAuthenticationMethods.mockResolvedValue({
			emailPassword: true,
			magicLink: false,
			passkey: false,
			social: [],
			turnstileSiteKey: "1x00000000000000000000AA",
		});
		window.history.replaceState({}, "", "/sign-in");
		render(<App />);

		await screen.findByRole("heading", {name: "Sign in"});
		await waitFor(() => {
			expect(widgetThemes).toStrictEqual(["light"]);
		});
		expect(paintedTheme()).toStrictEqual({attribute: "light", themeColor: "#f1f2f4"});
		delete window.turnstile;
	});
});
