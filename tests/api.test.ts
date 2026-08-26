// @vitest-environment project-jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {
	ApiResponseError,
	consumePasswordResetToken,
	CurrentDeckConnectionState,
	decideDeviceAuthorization,
	fetchAccountDevices,
	fetchAfk,
	fetchAuthenticationMethods,
	fetchDeviceAuthorization,
	fetchLinkedAccounts,
	fetchOAuthClient,
	fetchPasskeys,
	fetchSession,
	openCurrentDeckStream,
	registerAccount,
	requestPasswordReset,
	resumeOAuthAuthorization,
	sendMagicLink,
	sendVerificationEmail,
	signIn,
	signInForOAuth,
	signInWithPasskey,
	signOut,
	startSocialSignIn,
	submitAnswer,
	submitOAuthConsent,
	unlinkAccount,
	type LiveApplicationState,
} from "../src/api";
import {APPLICATION_UPDATE_EVENT} from "../src/application-updates";

const sessionUser = {
	id: "user-alice",
	email: "alice@example.com",
	emailVerified: true,
};

class FakeWebSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readonly sentMessages: string[] = [];
	readyState = FakeWebSocket.CONNECTING;

	constructor(readonly url: string | URL) {
		super();
		FakeWebSocket.instances.push(this);
	}

	close(): void {
		if (this.readyState === FakeWebSocket.CLOSED) {
			return;
		}
		this.readyState = FakeWebSocket.CLOSED;
		this.dispatchEvent(new CloseEvent("close"));
	}

	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.dispatchEvent(new Event("open"));
	}

	publish(data: string): void {
		this.dispatchEvent(new MessageEvent("message", {data}));
	}

	send(message: string): void {
		this.sentMessages.push(message);
	}
}

function latestSocket(): FakeWebSocket {
	const socket = FakeWebSocket.instances.at(-1);
	if (socket === undefined) {
		throw new Error("expected a WebSocket connection");
	}
	return socket;
}

function setOnline(online: boolean): void {
	Object.defineProperty(navigator, "onLine", {configurable: true, value: online});
}

function setVisibility(visibilityState: DocumentVisibilityState): void {
	Object.defineProperty(document, "visibilityState", {configurable: true, value: visibilityState});
}

function mockAvailableSession(): ReturnType<typeof vi.fn<typeof fetch>> {
	const fetchMock = vi.fn<typeof fetch>(async (input) => {
		await Promise.resolve();
		const url = String(input);
		if (url === "/api/auth/get-session") {
			return Response.json({user: sessionUser});
		}
		if (url === "/api/v1/current-deck/stream") {
			return new Response(null, {status: 426});
		}
		throw new Error(`unexpected fetch: ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

beforeEach(() => {
	vi.useFakeTimers();
	FakeWebSocket.instances = [];
	setOnline(true);
	setVisibility("visible");
	Object.defineProperty(navigator, "serviceWorker", {configurable: true, value: undefined});
	vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("account registration", () => {
	it("maps redacted MCP clients, browser sessions, and push subscriptions separately", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () =>
			Promise.resolve(
				Response.json({
					browser_sessions: [
						{
							id: "browser-session-management-id",
							display_name: "Chrome on Linux",
							created_at: 946_684_800_000,
							last_active_at: 946_771_200_000,
							expires_at: 947_289_600_000,
							current: true,
						},
					],
					connected_mcp_clients: [
						{
							id: "connected-client-management-id",
							display_name: "Codex",
							authorized_at: 946_684_800_000,
							last_used_at: 946_771_200_000,
							granted_scopes: ["openid", "yepnope:questions"],
							status: "active",
							revoked_at: null,
						},
					],
					push_devices: [
						{id: "push-subscription-management-id", label: "Alice browser", created_at: 946_684_800_000},
					],
				}),
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		expect(await fetchAccountDevices()).toStrictEqual({
			browserSessions: [
				{
					id: "browser-session-management-id",
					displayName: "Chrome on Linux",
					createdAt: 946_684_800_000,
					lastActiveAt: 946_771_200_000,
					expiresAt: 947_289_600_000,
					current: true,
				},
			],
			connectedMcpClients: [
				{
					id: "connected-client-management-id",
					displayName: "Codex",
					authorizedAt: 946_684_800_000,
					lastUsedAt: 946_771_200_000,
					grantedScopes: ["openid", "yepnope:questions"],
					status: "active",
					revokedAt: null,
				},
			],
			pushDevices: [{id: "push-subscription-management-id", label: "Alice browser", createdAt: 946_684_800_000}],
		});
		expect(fetchMock.mock.calls).toStrictEqual([["/api/v1/account/devices", {credentials: "same-origin"}]]);
	});

	it("sends only the email and password authentication fields", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () =>
			Promise.resolve(
				Response.json({
					message: "If the request can be completed, check your inbox for next steps.",
					status: true,
				}),
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		await registerAccount("alice@example.com", "example-password", null);
		expect(fetchMock.mock.calls).toStrictEqual([
			[
				"/api/auth/sign-up/email",
				{
					body: JSON.stringify({
						email: "alice@example.com",
						password: "example-password",
						callbackURL: "/verify-email",
					}),
					credentials: "same-origin",
					headers: {"Content-Type": "application/json"},
					method: "POST",
				},
			],
		]);
	});

	it("sends verification links back to the authenticated deck", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () =>
			Promise.resolve(
				Response.json({
					message: "If the request can be completed, check your inbox for next steps.",
					status: true,
				}),
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		await sendVerificationEmail("alice@example.com", null);
		expect(fetchMock.mock.calls).toStrictEqual([
			[
				"/api/auth/send-verification-email",
				{
					body: JSON.stringify({email: "alice@example.com", callbackURL: "/verify-email"}),
					credentials: "same-origin",
					headers: {"Content-Type": "application/json"},
					method: "POST",
				},
			],
		]);
	});

	it("keeps reset-token consumption separate from the fresh password sign-in", async () => {
		const fetchMock = vi.fn<typeof fetch>(async (input) => {
			const path = String(input);
			if (path === "/api/auth/request-password-reset") {
				return Promise.resolve(
					Response.json({
						message: "If the request can be completed, check your inbox for next steps.",
						status: true,
					}),
				);
			}
			if (path === "/api/auth/reset-password") {
				return Promise.resolve(Response.json({status: true}));
			}
			if (path === "/api/auth/sign-in/email") {
				return Promise.resolve(Response.json({user: sessionUser}));
			}
			throw new Error(`unexpected fetch: ${path}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		await requestPasswordReset("alice@example.com", null);
		await consumePasswordResetToken("one-time-reset-token", "replacement-password");
		expect(await signIn("alice@example.com", "replacement-password", null)).toStrictEqual(sessionUser);
		expect(fetchMock.mock.calls).toStrictEqual([
			[
				"/api/auth/request-password-reset",
				{
					body: JSON.stringify({email: "alice@example.com", redirectTo: "/reset-password"}),
					credentials: "same-origin",
					headers: {"Content-Type": "application/json"},
					method: "POST",
				},
			],
			[
				"/api/auth/reset-password",
				{
					body: JSON.stringify({token: "one-time-reset-token", newPassword: "replacement-password"}),
					credentials: "same-origin",
					headers: {"Content-Type": "application/json"},
					method: "POST",
				},
			],
			[
				"/api/auth/sign-in/email",
				{
					body: JSON.stringify({email: "alice@example.com", password: "replacement-password"}),
					credentials: "same-origin",
					headers: {"Content-Type": "application/json"},
					method: "POST",
				},
			],
		]);
	});

	it("normalizes raw authentication failures before exposing them to the browser", async () => {
		const rawFailures = [
			Response.json({code: "USER_NOT_FOUND", message: "User not found"}, {status: 400}),
			Response.json({code: "INVALID_PASSWORD", message: "Invalid password"}, {status: 401}),
			Response.json({code: "EMAIL_NOT_VERIFIED", message: "Email not verified"}, {status: 403}),
		];
		const fetchMock = vi.fn<typeof fetch>(async () => {
			const response = rawFailures.shift();
			if (response === undefined) {
				throw new Error("unexpected sign-in request");
			}
			return Promise.resolve(response);
		});
		vi.stubGlobal("fetch", fetchMock);

		const failures = [];
		for (const attempt of [
			async () => signIn("missing-alice@example.com", "example-password", null),
			async () => signIn("alice@example.com", "wrong-password", null),
			async () =>
				signInForOAuth("unverified-alice@example.com", "example-password", "client_id=oauth-client", null),
		]) {
			try {
				await attempt();
			} catch (caught) {
				if (!(caught instanceof ApiResponseError)) {
					throw caught;
				}
				failures.push({message: caught.message, name: caught.name, status: caught.status});
			}
		}

		expect(failures).toStrictEqual([
			{
				message: "Sign-in failed. Check your email and password, or recover your account.",
				name: "ApiResponseError",
				status: 401,
			},
			{
				message: "Sign-in failed. Check your email and password, or recover your account.",
				name: "ApiResponseError",
				status: 401,
			},
			{
				message: "Sign-in failed. Check your email and password, or recover your account.",
				name: "ApiResponseError",
				status: 401,
			},
		]);
	});
});

describe("OAuth authorization", () => {
	it("preserves the signed authorization request across sign-in, resume, and consent", async () => {
		const oauthQuery = "client_id=oauth-client&scope=openid&sig=signed-request";
		const fetchMock = vi.fn<typeof fetch>(async (input) => {
			await Promise.resolve();
			const path = String(input);
			if (path === "/api/auth/sign-in/email") {
				return Response.json({redirect: true, url: "https://yepnope.app/oauth/consent?continued=true"});
			}
			if (path === `/api/auth/oauth2/authorize?${oauthQuery}`) {
				return Response.json({redirect: true, url: "/oauth/consent?resumed=true"});
			}
			if (path === "/api/auth/oauth2/consent") {
				return Response.json({redirect: true, url: "http://127.0.0.1:45678/callback?result=approved"});
			}
			throw new Error(`unexpected fetch: ${path}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		expect({
			consent: await submitOAuthConsent(oauthQuery, true),
			resume: await resumeOAuthAuthorization(oauthQuery),
			signIn: await signInForOAuth("alice@example.com", "example-password", oauthQuery, null),
		}).toStrictEqual({
			consent: "http://127.0.0.1:45678/callback?result=approved",
			resume: "http://localhost:3000/oauth/consent?resumed=true",
			signIn: "https://yepnope.app/oauth/consent?continued=true",
		});
		expect(fetchMock.mock.calls).toStrictEqual([
			[
				"/api/auth/oauth2/consent",
				{
					body: JSON.stringify({accept: true, oauth_query: oauthQuery}),
					credentials: "same-origin",
					headers: {"Content-Type": "application/json"},
					method: "POST",
				},
			],
			[
				`/api/auth/oauth2/authorize?${oauthQuery}`,
				{credentials: "same-origin", headers: {Accept: "application/json"}},
			],
			[
				"/api/auth/sign-in/email",
				{
					body: JSON.stringify({
						callbackURL: `/sign-in?${oauthQuery}`,
						email: "alice@example.com",
						oauth_query: oauthQuery,
						password: "example-password",
					}),
					credentials: "same-origin",
					headers: {"Content-Type": "application/json"},
					method: "POST",
				},
			],
		]);
	});

	it("returns only display-safe public client metadata", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () =>
			Promise.resolve(
				Response.json({
					client_id: "oauth-client",
					client_name: "Codex",
					client_uri: "https://client.example.com",
				}),
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		expect(await fetchOAuthClient("oauth client/one")).toStrictEqual({
			id: "oauth-client",
			name: "Codex",
			uri: "https://client.example.com",
		});
		expect(fetchMock.mock.calls).toStrictEqual([
			["/api/auth/oauth2/public-client?client_id=oauth%20client%2Fone", {credentials: "same-origin"}],
		]);
	});
});

describe("device authorization", () => {
	it("maps the pending request and sends the code as a query parameter", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () =>
			Promise.resolve(
				Response.json({
					client_name: "Claude Code",
					scopes: ["openid", "offline_access", "yepnope:questions"],
					status: "pending",
					user_code: "WDJBMJHT",
				}),
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		expect(await fetchDeviceAuthorization("wdjb-mjht")).toStrictEqual({
			status: "pending",
			authorization: {
				clientName: "Claude Code",
				scopes: ["openid", "offline_access", "yepnope:questions"],
				userCode: "WDJBMJHT",
			},
		});
		expect(fetchMock.mock.calls).toStrictEqual([
			["/api/v1/device-authorization?user_code=wdjb-mjht", {credentials: "same-origin"}],
		]);
	});

	it("returns each dead end as a value the page can name", async () => {
		const fetchMock = vi.fn<typeof fetch>(async (input) => {
			await Promise.resolve();
			const code = new URL(String(input), window.location.origin).searchParams.get("user_code");
			if (code === "expired") {
				return Response.json({status: "expired"}, {status: 410});
			}
			if (code === "decided") {
				return Response.json({status: "decided"}, {status: 409});
			}
			return Response.json({status: "not_found"}, {status: 404});
		});
		vi.stubGlobal("fetch", fetchMock);

		expect({
			decided: await fetchDeviceAuthorization("decided"),
			expired: await fetchDeviceAuthorization("expired"),
			unknown: await fetchDeviceAuthorization("unknown"),
		}).toStrictEqual({
			decided: {status: "decided"},
			expired: {status: "expired"},
			unknown: {status: "not_found"},
		});
	});

	it("posts the decision in the query and the code in the body", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () =>
			Promise.resolve(Response.json({status: "decided", decision: "approved"})),
		);
		vi.stubGlobal("fetch", fetchMock);

		expect(await decideDeviceAuthorization("WDJBMJHT", "approved")).toStrictEqual({
			status: "decided",
			decision: "approved",
		});
		expect(fetchMock.mock.calls).toStrictEqual([
			[
				"/api/v1/device-authorization?decision=approved",
				{
					body: JSON.stringify({user_code: "WDJBMJHT"}),
					credentials: "same-origin",
					headers: {"Content-Type": "application/json"},
					method: "POST",
				},
			],
		]);
	});

	it("separates an answer already on file from losing the race to record one", async () => {
		const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
			await Promise.resolve();
			return String(init?.body).includes("TAKEN")
				? Response.json({status: "taken"}, {status: 409})
				: Response.json({status: "decided"}, {status: 409});
		});
		vi.stubGlobal("fetch", fetchMock);

		expect({
			decided: await decideDeviceAuthorization("DECIDED", "denied"),
			taken: await decideDeviceAuthorization("TAKEN", "approved"),
		}).toStrictEqual({decided: {status: "already_decided"}, taken: {status: "taken"}});
	});

	it("throws when the session is gone rather than inventing a dead end", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => Promise.resolve(new Response(null, {status: 401})));
		vi.stubGlobal("fetch", fetchMock);

		await expect(fetchDeviceAuthorization("WDJBMJHT")).rejects.toBeInstanceOf(ApiResponseError);
		await expect(decideDeviceAuthorization("WDJBMJHT", "approved")).rejects.toBeInstanceOf(ApiResponseError);
	});
});

describe("unreadable transport failures", () => {
	async function failureMessage(attempt: () => Promise<unknown>): Promise<string> {
		try {
			await attempt();
		} catch (caught) {
			return caught instanceof Error ? caught.message : String(caught);
		}
		return "resolved without an error";
	}

	it("renders surface copy rather than the route and status when the body carries no failure", async () => {
		// An overloaded Worker, a proxy, or a cache answers with an HTML page, not the {code, message}
		// JSON every deliberate refusal carries.
		const fetchMock = vi.fn<typeof fetch>(async () =>
			Promise.resolve(
				new Response("<!doctype html><title>503 Service Unavailable</title>", {
					headers: {"Content-Type": "text/html"},
					status: 503,
				}),
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);

		expect({
			accountDevices: await failureMessage(fetchAccountDevices),
			afk: await failureMessage(fetchAfk),
			answer: await failureMessage(async () => submitAnswer("question-id", "yep")),
			authenticationMethods: await failureMessage(fetchAuthenticationMethods),
			deviceAuthorizationDecision: await failureMessage(async () =>
				decideDeviceAuthorization("WDJBMJHT", "approved"),
			),
			deviceAuthorizationLookup: await failureMessage(async () => fetchDeviceAuthorization("WDJBMJHT")),
			linkedAccounts: await failureMessage(fetchLinkedAccounts),
			magicLink: await failureMessage(async () => sendMagicLink("alice@example.com", null)),
			oauthClient: await failureMessage(async () => fetchOAuthClient("oauth-client")),
			oauthConsent: await failureMessage(async () => submitOAuthConsent("client_id=oauth-client", true)),
			oauthResume: await failureMessage(async () => resumeOAuthAuthorization("client_id=oauth-client")),
			passkeyList: await failureMessage(fetchPasskeys),
			passkeySignIn: await failureMessage(signInWithPasskey),
			passwordReset: await failureMessage(async () => consumePasswordResetToken("token", "replacement")),
			recovery: await failureMessage(async () => requestPasswordReset("alice@example.com", null)),
			registration: await failureMessage(async () =>
				registerAccount("alice@example.com", "example-password", null),
			),
			session: await failureMessage(fetchSession),
			signIn: await failureMessage(async () => signIn("alice@example.com", "example-password", null)),
			signOut: await failureMessage(signOut),
			socialSignIn: await failureMessage(async () => startSocialSignIn("github")),
			unlink: await failureMessage(async () => unlinkAccount("account-github")),
			verification: await failureMessage(async () => sendVerificationEmail("alice@example.com", null)),
		}).toStrictEqual({
			accountDevices: "Your devices could not be loaded. Try again in a moment.",
			afk: "Your away status could not be loaded. Try again in a moment.",
			answer: "Your answer could not be sent. Try again in a moment.",
			authenticationMethods: "Sign-in options could not be loaded. Try again in a moment.",
			deviceAuthorizationDecision: "Your answer could not be recorded. Start again from your terminal.",
			deviceAuthorizationLookup: "The device request could not be loaded. Start again from your terminal.",
			linkedAccounts: "Your linked accounts could not be loaded. Try again in a moment.",
			magicLink: "The sign-in link could not be requested. Try again in a moment.",
			oauthClient: "This MCP client could not be verified. Start the connection again from the client.",
			oauthConsent: "Your answer could not be recorded. Start the connection again from your client.",
			oauthResume: "The authorization request could not be resumed. Start the connection again from your client.",
			passkeyList: "Your passkeys could not be loaded. Try again in a moment.",
			passkeySignIn: "Passkey sign-in failed. Try again, or use another way to sign in.",
			passwordReset: "Your password could not be reset. Request a new recovery email.",
			recovery: "Recovery could not be requested. Try again in a moment.",
			registration: "Account creation could not be completed. Try again in a moment.",
			session: "Your sign-in status could not be confirmed. Try again in a moment.",
			signIn: "Sign-in failed. Check your email and password, or recover your account.",
			signOut: "Sign-out could not be completed. Try again in a moment.",
			socialSignIn: "That sign-in provider is unavailable right now. Try again in a moment.",
			unlink: "That account could not be unlinked. Try again in a moment.",
			verification: "Verification could not be requested. Try again in a moment.",
		});
	});

	it("hands the route and status to the console so an operator can still debug", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () =>
			Promise.resolve(new Response("upstream connect error", {status: 503})),
		);
		vi.stubGlobal("fetch", fetchMock);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		expect(await failureMessage(async () => signIn("alice@example.com", "example-password", null))).toBe(
			"Sign-in failed. Check your email and password, or recover your account.",
		);
		expect(warn.mock.calls).toStrictEqual([["POST /api/auth/sign-in/email failed with 503"]]);
	});
});

describe("openCurrentDeckStream", () => {
	it("backs off exponentially, opens its circuit at the failure limit, and lets user action retry", async () => {
		const fetchMock = mockAvailableSession();
		const stream = openCurrentDeckStream(() => undefined, {
			initialReconnectDelayMilliseconds: 100,
			maximumConsecutiveFailures: 4,
			maximumReconnectDelayMilliseconds: 1_000,
			random: () => 0.5,
			sessionRevalidationFailureCount: 2,
		});

		expect(FakeWebSocket.instances).toHaveLength(1);
		latestSocket().close();
		await vi.advanceTimersByTimeAsync(99);
		expect(FakeWebSocket.instances).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(FakeWebSocket.instances).toHaveLength(2);

		latestSocket().close();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock.mock.calls.map(([input]) => String(input))).toStrictEqual([
			"/api/auth/get-session",
			"/api/v1/current-deck/stream",
		]);
		await vi.advanceTimersByTimeAsync(199);
		expect(FakeWebSocket.instances).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(FakeWebSocket.instances).toHaveLength(3);

		latestSocket().close();
		await vi.advanceTimersByTimeAsync(400);
		expect(FakeWebSocket.instances).toHaveLength(4);
		latestSocket().close();
		await vi.advanceTimersByTimeAsync(10_000);
		expect({connections: FakeWebSocket.instances.length, state: stream.state()}).toStrictEqual({
			connections: 4,
			state: CurrentDeckConnectionState.CircuitOpen,
		});

		stream.refresh();
		expect({connections: FakeWebSocket.instances.length, state: stream.state()}).toStrictEqual({
			connections: 5,
			state: CurrentDeckConnectionState.Connecting,
		});
		stream.close();
	});

	it("stops after repeated failures reveal a signed-out Better Auth session", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => {
			await Promise.resolve();
			return Response.json(null);
		});
		vi.stubGlobal("fetch", fetchMock);
		const onSignedOut = vi.fn<() => void>();
		const stream = openCurrentDeckStream(() => undefined, {
			initialReconnectDelayMilliseconds: 100,
			maximumConsecutiveFailures: 4,
			onSignedOut,
			random: () => 0.5,
			sessionRevalidationFailureCount: 2,
		});

		latestSocket().close();
		await vi.advanceTimersByTimeAsync(100);
		latestSocket().close();
		await vi.advanceTimersByTimeAsync(10_000);

		expect({
			connections: FakeWebSocket.instances.length,
			sessionChecks: fetchMock.mock.calls,
			state: stream.state(),
		}).toStrictEqual({
			connections: 2,
			sessionChecks: [["/api/auth/get-session", {cache: "no-store", credentials: "same-origin"}]],
			state: CurrentDeckConnectionState.Stopped,
		});
		expect(onSignedOut.mock.calls).toStrictEqual([[]]);
	});

	it.each([401, 403])("stops after stream access revalidation returns %i", async (status) => {
		const fetchMock = vi.fn<typeof fetch>(async (input) => {
			await Promise.resolve();
			return String(input) === "/api/auth/get-session"
				? Response.json({user: sessionUser})
				: new Response(null, {status});
		});
		vi.stubGlobal("fetch", fetchMock);
		const onSignedOut = vi.fn<() => void>();
		const stream = openCurrentDeckStream(() => undefined, {
			initialReconnectDelayMilliseconds: 100,
			maximumConsecutiveFailures: 4,
			onSignedOut,
			random: () => 0.5,
			sessionRevalidationFailureCount: 2,
		});

		latestSocket().close();
		await vi.advanceTimersByTimeAsync(100);
		latestSocket().close();
		await vi.advanceTimersByTimeAsync(10_000);

		expect({
			connections: FakeWebSocket.instances.length,
			sessionChecks: fetchMock.mock.calls,
			state: stream.state(),
		}).toStrictEqual({
			connections: 2,
			sessionChecks: [
				["/api/auth/get-session", {cache: "no-store", credentials: "same-origin"}],
				["/api/v1/current-deck/stream", {credentials: "same-origin"}],
			],
			state: CurrentDeckConnectionState.Stopped,
		});
		expect(onSignedOut.mock.calls).toStrictEqual([[]]);
	});

	it("opens its circuit when session revalidation finds an unsupported stream endpoint", async () => {
		const fetchMock = vi.fn<typeof fetch>(async (input) => {
			await Promise.resolve();
			return String(input) === "/api/auth/get-session"
				? Response.json({user: sessionUser})
				: new Response(null, {status: 404});
		});
		vi.stubGlobal("fetch", fetchMock);
		const stream = openCurrentDeckStream(() => undefined, {
			initialReconnectDelayMilliseconds: 100,
			maximumConsecutiveFailures: 4,
			random: () => 0.5,
			sessionRevalidationFailureCount: 2,
		});

		latestSocket().close();
		await vi.advanceTimersByTimeAsync(100);
		latestSocket().close();
		await vi.advanceTimersByTimeAsync(10_000);

		expect({connections: FakeWebSocket.instances.length, state: stream.state()}).toStrictEqual({
			connections: 2,
			state: CurrentDeckConnectionState.CircuitOpen,
		});
	});

	it("pauses reconnects while offline or hidden and resumes on browser lifecycle signals", async () => {
		mockAvailableSession();
		setOnline(false);
		const stream = openCurrentDeckStream(() => undefined, {
			initialReconnectDelayMilliseconds: 100,
			random: () => 0.5,
		});
		expect({connections: FakeWebSocket.instances.length, state: stream.state()}).toStrictEqual({
			connections: 0,
			state: CurrentDeckConnectionState.Paused,
		});

		setOnline(true);
		window.dispatchEvent(new Event("online"));
		expect(FakeWebSocket.instances).toHaveLength(1);
		setVisibility("hidden");
		latestSocket().close();
		await vi.advanceTimersByTimeAsync(10_000);
		expect({connections: FakeWebSocket.instances.length, state: stream.state()}).toStrictEqual({
			connections: 1,
			state: CurrentDeckConnectionState.Paused,
		});

		setVisibility("visible");
		document.dispatchEvent(new Event("visibilitychange"));
		expect(FakeWebSocket.instances).toHaveLength(2);
		window.dispatchEvent(new PageTransitionEvent("pagehide"));
		expect({readyState: latestSocket().readyState, state: stream.state()}).toStrictEqual({
			readyState: FakeWebSocket.CLOSED,
			state: CurrentDeckConnectionState.Stopped,
		});
	});

	it("resets the failure streak after a healthy state and reconnects from the base delay", async () => {
		mockAvailableSession();
		const states: LiveApplicationState[] = [];
		const stream = openCurrentDeckStream((state) => states.push(state), {
			initialReconnectDelayMilliseconds: 100,
			maximumConsecutiveFailures: 4,
			random: () => 0.5,
			sessionRevalidationFailureCount: 3,
		});

		latestSocket().close();
		await vi.advanceTimersByTimeAsync(100);
		latestSocket().close();
		await vi.advanceTimersByTimeAsync(200);
		latestSocket().open();
		latestSocket().publish(
			JSON.stringify({
				type: "current_deck",
				afk: false,
				connected_mcp_client_count: 1,
				current_deck: [],
			}),
		);
		latestSocket().close();
		await vi.advanceTimersByTimeAsync(99);
		expect(FakeWebSocket.instances).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(1);

		expect({connections: FakeWebSocket.instances.length, states}).toStrictEqual({
			connections: 4,
			states: [
				{
					afk: false,
					connectedMcpClientCount: 1,
					currentDeck: [],
				},
			],
		});
		stream.close();
	});

	it("closes an active socket when the application update protocol starts", () => {
		mockAvailableSession();
		const stream = openCurrentDeckStream(() => undefined);
		window.dispatchEvent(new Event(APPLICATION_UPDATE_EVENT));

		expect({readyState: latestSocket().readyState, state: stream.state()}).toStrictEqual({
			readyState: FakeWebSocket.CLOSED,
			state: CurrentDeckConnectionState.Stopped,
		});
	});
});
