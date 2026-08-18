const LEGACY_STORAGE_KEY = "yepnope.token";
const LEGACY_DATABASE_NAME = "yepnope";
const LEGACY_STORE_NAME = "kv";
const LEGACY_TOKEN_KEY = "token";

let migrationInProgress: Promise<boolean> | null = null;

async function legacyDatabaseExists(): Promise<boolean> {
	if (!("indexedDB" in globalThis)) {
		return false;
	}
	if (typeof indexedDB.databases !== "function") {
		return true;
	}
	const databases = await indexedDB.databases();
	return databases.some((database) => database.name === LEGACY_DATABASE_NAME);
}

async function openLegacyDatabase(): Promise<IDBDatabase | null> {
	if (!(await legacyDatabaseExists())) {
		return null;
	}
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(LEGACY_DATABASE_NAME, 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore(LEGACY_STORE_NAME);
		};
		request.onerror = () => {
			reject(new Error("failed to open the legacy token database"));
		};
		request.onsuccess = () => {
			resolve(request.result);
		};
	});
}

async function loadIndexedDatabaseToken(): Promise<string | null> {
	const database = await openLegacyDatabase();
	if (database === null) {
		return null;
	}
	return new Promise((resolve, reject) => {
		const transaction = database.transaction(LEGACY_STORE_NAME, "readonly");
		const request = transaction.objectStore(LEGACY_STORE_NAME).get(LEGACY_TOKEN_KEY);
		request.onerror = () => {
			database.close();
			reject(new Error("failed to read the legacy browser token"));
		};
		request.onsuccess = () => {
			database.close();
			resolve(typeof request.result === "string" ? request.result : null);
		};
	});
}

async function loadLegacyToken(): Promise<string | null> {
	return window.localStorage.getItem(LEGACY_STORAGE_KEY) ?? loadIndexedDatabaseToken();
}

async function clearLegacyToken(): Promise<void> {
	window.localStorage.removeItem(LEGACY_STORAGE_KEY);
	const database = await openLegacyDatabase();
	if (database === null) {
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const transaction = database.transaction(LEGACY_STORE_NAME, "readwrite");
		transaction.objectStore(LEGACY_STORE_NAME).delete(LEGACY_TOKEN_KEY);
		transaction.oncomplete = () => {
			database.close();
			resolve();
		};
		transaction.onerror = () => {
			database.close();
			reject(new Error("failed to remove the legacy browser token"));
		};
	});
}

export async function migrateLegacyIdentity(claim: (token: string) => Promise<void>): Promise<boolean> {
	migrationInProgress ??= migrate(claim).finally(() => {
		migrationInProgress = null;
	});
	return migrationInProgress;
}

async function migrate(claim: (token: string) => Promise<void>): Promise<boolean> {
	const token = await loadLegacyToken();
	if (token === null) {
		return false;
	}
	await claim(token);
	await clearLegacyToken();
	return true;
}
