import {z} from "zod";

declare const __APPLICATION_VERSION__: string;

export const APPLICATION_UPDATE_EVENT = "yepnope:application-update";
export const APPLICATION_VERSION = __APPLICATION_VERSION__;

const FORM_STATE_KEY = "yepnope:application-update-form-state";
const RELOADED_VERSION_KEY = "yepnope:application-update-reloaded-version";

interface FormControlState {
	checked: boolean | null;
	controlIndex: number;
	formIndex: number;
	selectedValues: string[];
	value: string;
}

interface FormState {
	controls: FormControlState[];
	location: string;
}

const formStateSchema = z.object({
	controls: z.array(
		z.object({
			checked: z.boolean().nullable(),
			controlIndex: z.number().int().nonnegative(),
			formIndex: z.number().int().nonnegative(),
			selectedValues: z.array(z.string()),
			value: z.string(),
		}),
	),
	location: z.string(),
});

interface ApplicationUpdateOptions {
	reload?: () => void;
}

function currentLocation(): string {
	return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function recoverableControl(element: Element): element is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
	if (element instanceof HTMLInputElement) {
		return !["file", "hidden", "password", "reset", "submit", "button", "image"].includes(element.type);
	}
	return element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement;
}

function saveRecoverableFormState(): void {
	const controls: FormControlState[] = [];
	for (const [formIndex, form] of Array.from(document.forms).entries()) {
		for (const [controlIndex, element] of Array.from(form.elements).entries()) {
			if (!recoverableControl(element)) {
				continue;
			}
			controls.push({
				checked:
					element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)
						? element.checked
						: null,
				controlIndex,
				formIndex,
				selectedValues:
					element instanceof HTMLSelectElement
						? Array.from(element.selectedOptions, (option) => option.value)
						: [],
				value: element.value,
			});
		}
	}
	if (controls.length === 0) {
		sessionStorage.removeItem(FORM_STATE_KEY);
		return;
	}
	const state: FormState = {controls, location: currentLocation()};
	sessionStorage.setItem(FORM_STATE_KEY, JSON.stringify(state));
}

function restoreRecoverableFormState(): void {
	const serializedState = sessionStorage.getItem(FORM_STATE_KEY);
	if (serializedState === null) {
		return;
	}
	const state: FormState = formStateSchema.parse(JSON.parse(serializedState) as unknown);
	sessionStorage.removeItem(FORM_STATE_KEY);
	if (state.location !== currentLocation()) {
		return;
	}
	for (const savedControl of state.controls) {
		const form = document.forms.item(savedControl.formIndex);
		const element = form?.elements.item(savedControl.controlIndex);
		if (element === null || element === undefined || !recoverableControl(element)) {
			continue;
		}
		if (element instanceof HTMLSelectElement) {
			for (const option of element.options) {
				option.selected = savedControl.selectedValues.includes(option.value);
			}
		} else if (element instanceof HTMLInputElement && savedControl.checked !== null) {
			element.checked = savedControl.checked;
		} else {
			element.value = savedControl.value;
		}
		element.dispatchEvent(new Event("input", {bubbles: true}));
		element.dispatchEvent(new Event("change", {bubbles: true}));
	}
}

function serviceWorkerVersion(message: unknown, expectedType: string): string | null {
	if (typeof message !== "object" || message === null) {
		return null;
	}
	return "type" in message &&
		message.type === expectedType &&
		"serviceWorkerVersion" in message &&
		typeof message.serviceWorkerVersion === "string"
		? message.serviceWorkerVersion
		: null;
}

function isServiceWorker(source: MessageEventSource | null): source is ServiceWorker {
	return source !== null && "scriptURL" in source;
}

function closeLiveConnections(): void {
	window.dispatchEvent(new Event(APPLICATION_UPDATE_EVENT));
}

export async function initializeApplicationUpdates(options: ApplicationUpdateOptions = {}): Promise<void> {
	if (!("serviceWorker" in navigator)) {
		return;
	}
	document.documentElement.dataset["applicationVersion"] = APPLICATION_VERSION;
	window.requestAnimationFrame(restoreRecoverableFormState);

	const workerContainer = navigator.serviceWorker;
	const reload =
		options.reload ??
		(() => {
			window.location.reload();
		});
	let controlled = workerContainer.controller !== null;
	let pendingServiceWorkerVersion: string | null = null;
	const requestedWorkers = new WeakSet<ServiceWorker>();

	function activateWaitingWorker(registration: ServiceWorkerRegistration): void {
		const waitingWorker = registration.waiting;
		if (waitingWorker === null || !controlled || requestedWorkers.has(waitingWorker)) {
			return;
		}
		requestedWorkers.add(waitingWorker);
		pendingServiceWorkerVersion = null;
		saveRecoverableFormState();
		closeLiveConnections();
		waitingWorker.postMessage({
			type: "activate-service-worker",
			applicationVersion: APPLICATION_VERSION,
		});
	}

	function observeInstallingWorker(registration: ServiceWorkerRegistration): void {
		const installingWorker = registration.installing;
		if (installingWorker === null) {
			return;
		}
		installingWorker.addEventListener("statechange", () => {
			if (installingWorker.state === "installed") {
				activateWaitingWorker(registration);
			}
		});
	}

	workerContainer.addEventListener("message", (event) => {
		const version = serviceWorkerVersion(event.data, "service-worker-version-probe");
		if (version === null) {
			return;
		}
		pendingServiceWorkerVersion = version;
		if (!isServiceWorker(event.source)) {
			return;
		}
		event.source.postMessage({
			type: "application-version",
			applicationVersion: APPLICATION_VERSION,
			serviceWorkerVersion: version,
		});
	});

	workerContainer.addEventListener("controllerchange", () => {
		if (!controlled) {
			controlled = true;
			return;
		}
		if (pendingServiceWorkerVersion === null) {
			return;
		}
		closeLiveConnections();
		if (sessionStorage.getItem(RELOADED_VERSION_KEY) === pendingServiceWorkerVersion) {
			return;
		}
		saveRecoverableFormState();
		sessionStorage.setItem(RELOADED_VERSION_KEY, pendingServiceWorkerVersion);
		reload();
	});

	const registration = await workerContainer.register("/sw.js", {updateViaCache: "none"});
	registration.addEventListener("updatefound", () => {
		observeInstallingWorker(registration);
	});
	observeInstallingWorker(registration);
	activateWaitingWorker(registration);

	async function checkForUpdate(): Promise<void> {
		await registration.update();
		activateWaitingWorker(registration);
	}

	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") {
			void checkForUpdate();
		}
	});
	await checkForUpdate();
}
