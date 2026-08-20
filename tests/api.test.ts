// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {
	ApiResponseError,
	consumePasswordResetToken,
	CurrentDeckConnectionState,
	fetchAccountDevices,
	fetchOAuthClient,
	openCurrentDeckStream,
	registerAccount,
	requestPasswordReset,
	resumeOAuthAuthorization,
	sendVerificationEmail,
	signIn,
	signInForOAuth,
	submitOAuthConsent,
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
