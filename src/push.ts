import {fetchVapidPublicKey, registerPushSubscription} from "./api";

// 📣 Web push subscribe path. On iOS this only works inside an installed PWA and the
// permission request must come from a user gesture (spec §6.3).

function base64UrlToBytes(encoded: string): Uint8Array<ArrayBuffer> {
	const padded = encoded.replaceAll("-", "+").replaceAll("_", "/");
	const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function pushSupported(): boolean {
	return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function isIos(): boolean {
	return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

export function isStandalone(): boolean {
	return window.matchMedia("(display-mode: standalone)").matches;
}

export type PushSetupResult = "subscribed" | "denied" | "unsupported";

// Call from a click handler: iOS refuses permission prompts outside a user gesture.
export async function enablePush(token: string): Promise<PushSetupResult> {
	if (!pushSupported()) {
		return "unsupported";
	}
	const permission = await Notification.requestPermission();
	if (permission !== "granted") {
		return "denied";
	}
	const registration = await navigator.serviceWorker.ready;
	const existing = await registration.pushManager.getSubscription();
	const subscription =
		existing ??
		(await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: base64UrlToBytes(await fetchVapidPublicKey()),
		}));
	await registerPushSubscription(token, subscription.toJSON());
	return "subscribed";
}

export function updateBadge(outstanding: number): void {
	if ("setAppBadge" in navigator) {
		if (outstanding > 0) {
			void navigator.setAppBadge(outstanding);
		} else {
			void navigator.clearAppBadge();
		}
	}
}
