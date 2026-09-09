import {afterEach, describe, expect, it, vi} from "vitest";
import {fetchVapidPublicKey, registerPushSubscription} from "../src/api";
import {enablePush, keysMatch, subscribeBody} from "../src/push";

vi.mock("../src/api", () => ({
	fetchVapidPublicKey: vi.fn<typeof fetchVapidPublicKey>(),
	registerPushSubscription: vi.fn<typeof registerPushSubscription>(),
}));

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetAllMocks();
});

describe("push subscription body", () => {
	const subscription = {endpoint: "https://example.com/push/fresh", keys: {p256dh: "fake-key", auth: "fake-auth"}};

	it.each([null, subscription.endpoint])("omits a predecessor that is %s", (previousEndpoint) => {
		expect(subscribeBody(subscription, previousEndpoint)).toStrictEqual(subscription);
	});

	it("names a different predecessor", () => {
		expect(subscribeBody(subscription, "https://example.com/push/old")).toStrictEqual({
			...subscription,
			replaces: "https://example.com/push/old",
		});
	});
});

describe("push application server keys", () => {
	it("rejects a missing subscription key", () => {
		expect(keysMatch(null, new Uint8Array([0, 127, 255]))).toBe(false);
	});

	it.each([{bytes: [0, 127]}, {bytes: [0, 127, 255, 0]}])("rejects a different key length: $bytes", ({bytes}) => {
		expect(keysMatch(new Uint8Array(bytes).buffer, new Uint8Array([0, 127, 255]))).toBe(false);
	});

	it.each([{bytes: [1, 127, 255]}, {bytes: [0, 128, 255]}, {bytes: [0, 127, 254]}])(
		"rejects different key bytes: $bytes",
		({bytes}) => {
			expect(keysMatch(new Uint8Array(bytes).buffer, new Uint8Array([0, 127, 255]))).toBe(false);
		},
	);

	it("accepts identical bytes in separate buffers", () => {
		expect(keysMatch(new Uint8Array([0, 127, 255]).buffer, new Uint8Array([0, 127, 255]))).toBe(true);
	});
});

describe("push enrollment", () => {
	it("keeps the last registered endpoint when registration fails", async () => {
		const previousEndpoint = "https://example.com/push/old";
		const subscription = {endpoint: "https://example.com/push/fresh"};
		const setItem = vi.fn<Storage["setItem"]>();
		const removeItem = vi.fn<Storage["removeItem"]>();
		vi.stubGlobal("localStorage", {getItem: () => previousEndpoint, setItem, removeItem});
		const notification = {requestPermission: async () => Promise.resolve("granted")};
		vi.stubGlobal("window", {PushManager: {}, Notification: notification});
		vi.stubGlobal("Notification", notification);
		vi.stubGlobal("navigator", {
			serviceWorker: {
				ready: Promise.resolve({
					pushManager: {
						getSubscription: async () => Promise.resolve(null),
						subscribe: async () =>
							Promise.resolve({endpoint: subscription.endpoint, toJSON: () => subscription}),
					},
				}),
			},
		});
		vi.mocked(fetchVapidPublicKey).mockResolvedValue("AH__");
		vi.mocked(registerPushSubscription).mockRejectedValue(new Error("registration failed"));

		await expect(enablePush()).rejects.toThrow("registration failed");
		expect({
			registerCalls: vi.mocked(registerPushSubscription).mock.calls,
			writes: setItem.mock.calls,
			removals: removeItem.mock.calls,
		}).toStrictEqual({registerCalls: [[{...subscription, replaces: previousEndpoint}]], writes: [], removals: []});
	});

	it.each([
		{scenario: "creates a subscription when none exists", existing: false, key: null, replaces: false},
		{
			scenario: "reuses a subscription with the current key",
			existing: true,
			key: new Uint8Array([0, 127, 255]).buffer,
			replaces: false,
		},
		{
			scenario: "replaces a subscription with a rotated key",
			existing: true,
			key: new Uint8Array([0, 127, 254]).buffer,
			replaces: true,
		},
		{scenario: "replaces a subscription without a key", existing: true, key: null, replaces: true},
	])("$scenario", async ({existing, key, replaces}) => {
		const events: string[] = [];
		const storage = new Map([["yepnope:push-endpoint", "https://example.com/push/existing"]]);
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => {
				storage.set(key, value);
				events.push("remembered");
			},
			removeItem: (key: string) => {
				storage.delete(key);
				events.push("forgotten");
			},
		});
		const existingSubscriptionJson = {endpoint: "https://example.com/push/existing"};
		const freshSubscriptionJson = {endpoint: "https://example.com/push/fresh"};
		const unsubscribe = vi.fn<PushSubscription["unsubscribe"]>(async () => {
			await Promise.resolve();
			events.push("unsubscribed");
			return true;
		});
		const subscribe = vi.fn<
			(options: PushSubscriptionOptionsInit) => Promise<Pick<PushSubscription, "toJSON" | "endpoint">>
		>(async () => {
			events.push("subscribed");
			return Promise.resolve({endpoint: freshSubscriptionJson.endpoint, toJSON: () => freshSubscriptionJson});
		});
		const existingSubscription = {
			endpoint: existingSubscriptionJson.endpoint,
			options: {applicationServerKey: key},
			unsubscribe,
			toJSON: () => existingSubscriptionJson,
		};
		const getSubscription = vi.fn<() => Promise<typeof existingSubscription | null>>(async () =>
			Promise.resolve(existing ? existingSubscription : null),
		);
		const requestPermission = vi.fn<() => Promise<NotificationPermission>>(async () => Promise.resolve("granted"));
		const notification = {requestPermission};
		vi.stubGlobal("window", {PushManager: {}, Notification: notification});
		vi.stubGlobal("Notification", notification);
		vi.stubGlobal("navigator", {
			serviceWorker: {ready: Promise.resolve({pushManager: {getSubscription, subscribe}})},
		});
		vi.mocked(fetchVapidPublicKey).mockResolvedValue("AH__");
		vi.mocked(registerPushSubscription).mockImplementation(async () => {
			events.push("registered");
			await Promise.resolve();
		});

		const result = await enablePush();

		expect({
			result,
			permissionCalls: requestPermission.mock.calls,
			publicKeyCalls: vi.mocked(fetchVapidPublicKey).mock.calls,
			getSubscriptionCalls: getSubscription.mock.calls,
			unsubscribeCalls: unsubscribe.mock.calls,
			subscribeCalls: subscribe.mock.calls,
			registerCalls: vi.mocked(registerPushSubscription).mock.calls,
			events,
			storage,
		}).toStrictEqual({
			result: "subscribed",
			permissionCalls: [[]],
			publicKeyCalls: [[]],
			getSubscriptionCalls: [[]],
			unsubscribeCalls: replaces ? [[]] : [],
			subscribeCalls:
				!existing || replaces
					? [[{userVisibleOnly: true, applicationServerKey: new Uint8Array([0, 127, 255])}]]
					: [],
			registerCalls: [
				[
					!existing || replaces
						? {...freshSubscriptionJson, replaces: existingSubscriptionJson.endpoint}
						: existingSubscriptionJson,
				],
			],
			storage: new Map([
				[
					"yepnope:push-endpoint",
					!existing || replaces ? freshSubscriptionJson.endpoint : existingSubscriptionJson.endpoint,
				],
			]),
			events: replaces
				? ["unsubscribed", "forgotten", "subscribed", "registered", "remembered"]
				: existing
					? ["registered", "remembered"]
					: ["subscribed", "registered", "remembered"],
		});
	});
});
