import {fetchVapidPublicKey, registerPushSubscription, type PushSubscribeBody} from "./api";

// 📣 Web push subscribe path. On iOS this only works inside an installed PWA and the
// permission request must come from a user gesture (spec §6.3).

function base64UrlToBytes(encoded: string): Uint8Array<ArrayBuffer> {
	const padded = encoded.replaceAll("-", "+").replaceAll("_", "/");
	const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function keysMatch(subscriptionKey: ArrayBuffer | null, publicKey: Uint8Array): boolean {
	if (subscriptionKey === null || subscriptionKey.byteLength !== publicKey.byteLength) {
		return false;
	}
	const bytes = new Uint8Array(subscriptionKey);
	return bytes.every((byte, index) => byte === publicKey[index]);
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

const REGISTERED_ENDPOINT_KEY = "yepnope:push-endpoint";

export function subscribeBody(subscription: PushSubscriptionJSON, previousEndpoint: string | null): PushSubscribeBody {
	return previousEndpoint !== null && previousEndpoint !== subscription.endpoint
		? {...subscription, replaces: previousEndpoint}
		: subscription;
}

export type PushSetupResult = "subscribed" | "denied" | "unsupported";

// Call from a click handler: iOS refuses permission prompts outside a user gesture.
export async function enablePush(): Promise<PushSetupResult> {
	if (!pushSupported()) {
		return "unsupported";
	}
	const permission = await Notification.requestPermission();
	if (permission !== "granted") {
		return "denied";
	}
	const registration = await navigator.serviceWorker.ready;
	const applicationServerKey = base64UrlToBytes(await fetchVapidPublicKey());
	const previousEndpoint = localStorage.getItem(REGISTERED_ENDPOINT_KEY);
	let existing = await registration.pushManager.getSubscription();
	if (existing !== null && !keysMatch(existing.options.applicationServerKey, applicationServerKey)) {
		await existing.unsubscribe();
		localStorage.removeItem(REGISTERED_ENDPOINT_KEY);
		existing = null;
	}
	const subscription =
		existing ??
		(await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey,
		}));
	await registerPushSubscription(subscribeBody(subscription.toJSON(), previousEndpoint));
	localStorage.setItem(REGISTERED_ENDPOINT_KEY, subscription.endpoint);
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
