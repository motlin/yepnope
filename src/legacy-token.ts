const LEGACY_STORAGE_KEY = "yepnope.token";

export function loadLegacyToken(): string | null {
	return window.localStorage.getItem(LEGACY_STORAGE_KEY);
}

export function clearLegacyToken(): void {
	window.localStorage.removeItem(LEGACY_STORAGE_KEY);
	if ("indexedDB" in globalThis) {
		indexedDB.deleteDatabase("yepnope");
	}
}
