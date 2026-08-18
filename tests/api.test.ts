// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {
	CurrentDeckConnectionState,
	openCurrentDeckStream,
	registerAccount,
	sendVerificationEmail,
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
	it("sends only the email and password authentication fields", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () => Promise.resolve(Response.json({user: sessionUser})));
		vi.stubGlobal("fetch", fetchMock);

		expect(await registerAccount("alice@example.com", "example-password")).toStrictEqual(sessionUser);
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
		const fetchMock = vi.fn<typeof fetch>(async () => Promise.resolve(Response.json({status: true})));
		vi.stubGlobal("fetch", fetchMock);

		await sendVerificationEmail("alice@example.com");
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
			sessionChecks: [["/api/auth/get-session", {credentials: "same-origin"}]],
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
				paired: true,
				machine_count: 1,
				pending_pairing_expires_at: null,
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
					pairingStatus: {paired: true, machineCount: 1, pendingPairingExpiresAt: null},
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
