// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {migrateLegacyIdentity} from "../src/legacy-token";

interface FakeRequest {
	result: string | undefined;
	onerror: (() => void) | null;
	onsuccess: (() => void) | null;
}

interface FakeTransaction {
	oncomplete: (() => void) | null;
	onerror: (() => void) | null;
	objectStore: () => {delete: (key: string) => void; get: (key: string) => FakeRequest};
}

function installLegacyIndexedDatabase(token: string) {
	const values = new Map<string, string>([["token", token]]);
	const database = {
		close: vi.fn<() => void>(),
		createObjectStore: vi.fn<(_name: string) => void>(),
		transaction: vi.fn<(_storeName: string, _mode: IDBTransactionMode) => FakeTransaction>(() => {
			const transaction: FakeTransaction = {
				oncomplete: null,
				onerror: null,
				objectStore: () => ({
					delete: (key) => {
						values.delete(key);
						queueMicrotask(() => transaction.oncomplete?.());
					},
					get: (key) => {
						const request: FakeRequest = {result: undefined, onerror: null, onsuccess: null};
						queueMicrotask(() => {
							request.result = values.get(key);
							request.onsuccess?.();
						});
						return request;
					},
				}),
			};
			return transaction;
		}),
	};
	const indexedDatabase = {
		databases: vi.fn<() => Promise<Array<{name: string}>>>(async () => Promise.resolve([{name: "yepnope"}])),
		open: vi.fn<
			(
				_name: string,
				_version: number,
			) => {
				result: typeof database;
				onerror: (() => void) | null;
				onsuccess: (() => void) | null;
				onupgradeneeded: (() => void) | null;
			}
		>(() => {
			const request: {
				result: typeof database;
				onerror: (() => void) | null;
				onsuccess: (() => void) | null;
				onupgradeneeded: (() => void) | null;
			} = {result: database, onerror: null, onsuccess: null, onupgradeneeded: null};
			queueMicrotask(() => request.onsuccess?.());
			return request;
		}),
	};
	vi.stubGlobal("indexedDB", indexedDatabase);
	return {indexedDatabase, values};
}

beforeEach(() => {
	const values = new Map<string, string>();
	Object.defineProperty(window, "localStorage", {
		configurable: true,
		value: {
			clear: () => {
				values.clear();
			},
			getItem: (key: string) => values.get(key) ?? null,
			key: (index: number) => [...values.keys()][index] ?? null,
			get length() {
				return values.size;
			},
			removeItem: (key: string) => values.delete(key),
			setItem: (key: string, value: string) => values.set(key, value),
		} satisfies Storage,
	});
});

afterEach(() => {
	window.localStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("legacy browser identity migration", () => {
	it("claims an IndexedDB-only token once across concurrent initialization", async () => {
		const {indexedDatabase, values} = installLegacyIndexedDatabase("legacy-browser-token");
		const claim = vi.fn<(_token: string) => Promise<void>>(async () => Promise.resolve());

		expect(await Promise.all([migrateLegacyIdentity(claim), migrateLegacyIdentity(claim)])).toStrictEqual([
			true,
			true,
		]);
		expect(claim.mock.calls).toStrictEqual([["legacy-browser-token"]]);
		expect(values).toStrictEqual(new Map());
		expect(indexedDatabase.open.mock.calls).toStrictEqual([
			["yepnope", 1],
			["yepnope", 1],
		]);
		expect(await migrateLegacyIdentity(claim)).toBe(false);
		expect(claim.mock.calls).toStrictEqual([["legacy-browser-token"]]);
	});

	it("prefers localStorage and removes both copies after a successful claim", async () => {
		const {values} = installLegacyIndexedDatabase("stale-indexeddb-token");
		window.localStorage.setItem("yepnope.token", "current-local-token");
		const claim = vi.fn<(_token: string) => Promise<void>>(async () => Promise.resolve());

		expect(await migrateLegacyIdentity(claim)).toBe(true);
		expect(claim.mock.calls).toStrictEqual([["current-local-token"]]);
		expect(window.localStorage.getItem("yepnope.token")).toBeNull();
		expect(values).toStrictEqual(new Map());
	});
});
