import {readFile} from "node:fs/promises";
import {runInNewContext} from "node:vm";
import {beforeAll, describe, expect, it, vi} from "vitest";

interface PushPayload {
	batch_id: string;
	project: string;
	count: number;
	outstanding: number;
}

interface ServiceWorkerHarness {
	clearAppBadge: ReturnType<typeof vi.fn>;
	dispatchNotificationClick(payload: Record<string, unknown>, action: string): Promise<void>;
	dispatchPush(payload: PushPayload): Promise<void>;
	fetchMock: ReturnType<typeof vi.fn>;
	showNotification: ReturnType<typeof vi.fn>;
	setAppBadge: ReturnType<typeof vi.fn>;
}

let serviceWorkerSource = "";

beforeAll(async () => {
	serviceWorkerSource = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
});

function createHarness(options: {
	userAgent: string;
	maxActions: number;
	fetchQuestions: () => Promise<unknown>;
}): ServiceWorkerHarness {
	const listeners = new Map<string, (event: unknown) => void>();
	const showNotification = vi.fn<(title: string, notificationOptions: unknown) => Promise<void>>(async () =>
		Promise.resolve(),
	);
	const setAppBadge = vi.fn<(outstanding: number) => Promise<void>>(async () => Promise.resolve());
	const clearAppBadge = vi.fn<() => Promise<void>>(async () => Promise.resolve());
	const fetchMock = vi.fn<() => Promise<unknown>>(options.fetchQuestions);
	const self = {
		Notification: {maxActions: options.maxActions},
		addEventListener(type: string, listener: (event: unknown) => void) {
			listeners.set(type, listener);
		},
		clients: {
			claim: vi.fn<() => Promise<void>>(async () => Promise.resolve()),
			matchAll: vi.fn<() => Promise<unknown[]>>(async () => Promise.resolve([])),
			openWindow: vi.fn<(url: string) => Promise<void>>(async () => Promise.resolve()),
		},
		registration: {showNotification},
		skipWaiting: vi.fn<() => Promise<void>>(async () => Promise.resolve()),
	};
	const navigator = {
		userAgent: options.userAgent,
		setAppBadge,
		clearAppBadge,
	};
	runInNewContext(serviceWorkerSource, {fetch: fetchMock, navigator, self});

	return {
		clearAppBadge,
		fetchMock,
		showNotification,
		setAppBadge,
		async dispatchNotificationClick(payload, action) {
			let completion = Promise.resolve();
			const listener = listeners.get("notificationclick");
			if (listener === undefined) {
				throw new Error("notification click listener was not registered");
			}
			listener({
				action,
				notification: {close: vi.fn<() => void>(), data: payload},
				waitUntil(promise: Promise<unknown>) {
					completion = promise.then(() => undefined);
				},
			});
			await completion;
		},
		async dispatchPush(payload) {
			let completion = Promise.resolve();
			const listener = listeners.get("push");
			if (listener === undefined) {
				throw new Error("push listener was not registered");
			}
			listener({
				data: {json: () => payload},
				waitUntil(promise: Promise<unknown>) {
					completion = promise.then(() => undefined);
				},
			});
			await completion;
		},
	};
}

function callsFrom(mock: ReturnType<typeof vi.fn>): unknown {
	return JSON.parse(JSON.stringify(mock.mock.calls));
}

const singlePayload: PushPayload = {
	batch_id: "batch-100",
	project: "demo",
	count: 1,
	outstanding: 1,
};

const singleQuestionResponse = {
	ok: true,
	json: async () =>
		Promise.resolve({
			current_deck: [
				{
					batch_id: "batch-100",
					project: "demo",
					question_id: "question-100",
					position: 0,
					title: "Ship the release?",
					body: "Publish the tested build.",
					created_at: 946_684_800_000,
					repo: null,
					branch: null,
					worktree: null,
					directory: null,
				},
			],
		}),
};

describe("service worker push notifications", () => {
	it.each([
		["Android", "Mozilla/5.0 (Linux; Android 15)"],
		["desktop", "Mozilla/5.0 (X11; Linux x86_64)"],
	])("fetches a single question and shows actions on %s", async (_platform, userAgent) => {
		const harness = createHarness({
			userAgent,
			maxActions: 2,
			fetchQuestions: async () => Promise.resolve(singleQuestionResponse),
		});

		await harness.dispatchPush(singlePayload);

		expect(callsFrom(harness.fetchMock)).toStrictEqual([["/api/v1/current-deck", {credentials: "same-origin"}]]);
		expect(callsFrom(harness.showNotification)).toStrictEqual([
			[
				"Ship the release?",
				{
					actions: [
						{action: "yep", title: "Yep"},
						{action: "nope", title: "Nope"},
					],
					badge: "/icons/badge-96.png",
					body: "demo",
					data: {...singlePayload, question_id: "question-100"},
					icon: "/icons/icon-192.png",
					tag: "batch-100",
				},
			],
		]);
		expect(callsFrom(harness.setAppBadge)).toStrictEqual([[1]]);
	});

	it("keeps a single-question notification generic on iOS", async () => {
		const harness = createHarness({
			userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
			maxActions: 2,
			fetchQuestions: async () => Promise.resolve(singleQuestionResponse),
		});

		await harness.dispatchPush(singlePayload);

		expect(callsFrom(harness.fetchMock)).toStrictEqual([["/api/v1/current-deck", {credentials: "same-origin"}]]);
		expect(callsFrom(harness.showNotification)).toStrictEqual([
			[
				"1 question from demo",
				{
					badge: "/icons/badge-96.png",
					body: "Open to swipe.",
					data: singlePayload,
					icon: "/icons/icon-192.png",
					tag: "batch-100",
				},
			],
		]);
	});

	it("keeps a single-question notification generic when actions are unsupported", async () => {
		const harness = createHarness({
			userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
			maxActions: 0,
			fetchQuestions: async () => Promise.resolve(singleQuestionResponse),
		});

		await harness.dispatchPush(singlePayload);

		expect(callsFrom(harness.showNotification)).toStrictEqual([
			[
				"1 question from demo",
				{
					badge: "/icons/badge-96.png",
					body: "Open to swipe.",
					data: singlePayload,
					icon: "/icons/icon-192.png",
					tag: "batch-100",
				},
			],
		]);
	});

	it("keeps multi-question notifications generic", async () => {
		const payload = {...singlePayload, count: 2, outstanding: 2};
		const harness = createHarness({
			userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
			maxActions: 2,
			fetchQuestions: async () =>
				Promise.resolve({ok: true, json: async () => Promise.resolve({current_deck: []})}),
		});

		await harness.dispatchPush(payload);

		expect(callsFrom(harness.showNotification)).toStrictEqual([
			[
				"2 questions from demo",
				{
					badge: "/icons/badge-96.png",
					body: "Open to swipe.",
					data: payload,
					icon: "/icons/icon-192.png",
					tag: "batch-100",
				},
			],
		]);
	});

	it("falls back to a generic notification and preserves the badge when content fetch fails", async () => {
		const harness = createHarness({
			userAgent: "Mozilla/5.0 (Linux; Android 15)",
			maxActions: 2,
			fetchQuestions: async () => Promise.reject(new Error("test network failure")),
		});

		await harness.dispatchPush(singlePayload);

		expect(callsFrom(harness.showNotification)).toStrictEqual([
			[
				"1 question from demo",
				{
					badge: "/icons/badge-96.png",
					body: "Open to swipe.",
					data: singlePayload,
					icon: "/icons/icon-192.png",
					tag: "batch-100",
				},
			],
		]);
		expect(callsFrom(harness.setAppBadge)).toStrictEqual([[1]]);
	});

	it("answers notification actions with the Better Auth session cookie", async () => {
		const harness = createHarness({
			userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
			maxActions: 2,
			fetchQuestions: async () => Promise.resolve({ok: true}),
		});

		await harness.dispatchNotificationClick(
			{batch_id: "batch-100", outstanding: 1, question_id: "question-100"},
			"yep",
		);

		expect(callsFrom(harness.fetchMock)).toStrictEqual([
			[
				"/api/v1/answers",
				{
					body: JSON.stringify({answers: [{question_id: "question-100", disposition: "yep"}]}),
					credentials: "same-origin",
					headers: {"Content-Type": "application/json"},
					method: "POST",
				},
			],
		]);
		expect(callsFrom(harness.setAppBadge)).toStrictEqual([]);
		expect(callsFrom(harness.clearAppBadge)).toStrictEqual([[]]);
	});
});
