// 🔑 The app token lives in localStorage for the app and is mirrored into IndexedDB,
// because the service worker cannot read localStorage but must answer from notifications.

const STORAGE_KEY = "yepnope.token";
const DB_NAME = "yepnope";
const STORE_NAME = "kv";

export function loadToken(): string | null {
	return localStorage.getItem(STORAGE_KEY);
}

async function mirrorTokenForServiceWorker(token: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const open = indexedDB.open(DB_NAME, 1);
		open.onupgradeneeded = () => {
			open.result.createObjectStore(STORE_NAME);
		};
		open.onerror = () => {
			reject(new Error("failed to open the token database"));
		};
		open.onsuccess = () => {
			const database = open.result;
			const transaction = database.transaction(STORE_NAME, "readwrite");
			transaction.objectStore(STORE_NAME).put(token, "token");
			transaction.oncomplete = () => {
				database.close();
				resolve();
			};
			transaction.onerror = () => {
				database.close();
				reject(new Error("failed to store the token"));
			};
		};
	});
}

export async function saveToken(token: string): Promise<void> {
	localStorage.setItem(STORAGE_KEY, token);
	await mirrorTokenForServiceWorker(token);
}
