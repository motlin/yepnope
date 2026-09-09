import {afterEach, describe, expect, it, vi} from "vitest";
import {fetchVapidPublicKey, registerPushSubscription} from "../src/api";
import {enablePush, keysMatch} from "../src/push";

vi.mock("../src/api", () => ({
	fetchVapidPublicKey: vi.fn<typeof fetchVapidPublicKey>(),
	registerPushSubscription: vi.fn<typeof registerPushSubscription>(),
}));

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetAllMocks();
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
		const existingSubscriptionJson = {endpoint: "https://example.com/push/existing"};
		const freshSubscriptionJson = {endpoint: "https://example.com/push/fresh"};
		const unsubscribe = vi.fn<PushSubscription["unsubscribe"]>(async () => {
			await Promise.resolve();
			events.push("unsubscribed");
			return true;
		});
		const subscribe = vi.fn<(options: PushSubscriptionOptionsInit) => Promise<Pick<PushSubscription, "toJSON">>>(
			async () => {
				events.push("subscribed");
				return Promise.resolve({toJSON: () => freshSubscriptionJson});
			},
		);
		const existingSubscription = {
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
			registerCalls: [[!existing || replaces ? freshSubscriptionJson : existingSubscriptionJson]],
			events: replaces
				? ["unsubscribed", "subscribed", "registered"]
				: existing
					? ["registered"]
					: ["subscribed", "registered"],
		});
	});
});
