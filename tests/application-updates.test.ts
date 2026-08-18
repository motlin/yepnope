// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {APPLICATION_UPDATE_EVENT, APPLICATION_VERSION, initializeApplicationUpdates} from "../src/application-updates";

class FakeServiceWorker extends EventTarget {
	readonly messages: unknown[] = [];
	readonly scriptURL = "https://example.com/sw.js";
	state: ServiceWorkerState = "installed";

	postMessage(message: unknown): void {
		this.messages.push(message);
	}
}

class FakeServiceWorkerRegistration extends EventTarget {
	installing: ServiceWorker | null = null;
	waiting: ServiceWorker | null;
	readonly update = vi.fn<() => Promise<void>>(async () => Promise.resolve());

	constructor(waitingWorker: FakeServiceWorker | null) {
		super();
		this.waiting = waitingWorker as ServiceWorker | null;
	}
}

class FakeServiceWorkerContainer extends EventTarget {
	controller: ServiceWorker | null;
	readonly registrations: Array<{options: RegistrationOptions; scriptUrl: string}> = [];

	constructor(
		controller: FakeServiceWorker | null,
		private readonly registration: FakeServiceWorkerRegistration,
	) {
		super();
		this.controller = controller as ServiceWorker | null;
	}

	async register(scriptUrl: string, options: RegistrationOptions): Promise<ServiceWorkerRegistration> {
		this.registrations.push({options, scriptUrl});
		return Promise.resolve(this.registration as unknown as ServiceWorkerRegistration);
	}
}

function dispatchVersionProbe(container: FakeServiceWorkerContainer, worker: FakeServiceWorker, version: string): void {
	container.dispatchEvent(
		new MessageEvent("message", {
			data: {type: "service-worker-version-probe", serviceWorkerVersion: version},
			source: worker as unknown as MessageEventSource,
		}),
	);
}

function setVisibility(visibilityState: DocumentVisibilityState): void {
	Object.defineProperty(document, "visibilityState", {configurable: true, value: visibilityState});
}

beforeEach(() => {
	document.body.innerHTML = "";
	sessionStorage.clear();
	setVisibility("visible");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("application service worker updates", () => {
	it("checks for updates, activates through the version handshake, restores form state, and reloads once", async () => {
		const animationFrames: FrameRequestCallback[] = [];
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
			animationFrames.push(callback);
			return animationFrames.length;
		});
		document.body.innerHTML = `
			<form>
				<input name="email" type="email" value="alice@example.com">
				<input name="password" type="password" value="test-password">
			</form>
		`;

		const activeWorker = new FakeServiceWorker();
		const waitingWorker = new FakeServiceWorker();
		const registration = new FakeServiceWorkerRegistration(waitingWorker);
		const container = new FakeServiceWorkerContainer(activeWorker, registration);
		Object.defineProperty(navigator, "serviceWorker", {configurable: true, value: container});
		const reload = vi.fn<() => void>();
		let updateEvents = 0;
		window.addEventListener(APPLICATION_UPDATE_EVENT, () => {
			updateEvents += 1;
		});

		await initializeApplicationUpdates({reload});
		animationFrames.shift()?.(0);
		document.dispatchEvent(new Event("visibilitychange"));
		await Promise.resolve();
		dispatchVersionProbe(container, waitingWorker, "service-worker-version-n-plus-one");
		container.controller = waitingWorker as unknown as ServiceWorker;
		container.dispatchEvent(new Event("controllerchange"));
		container.dispatchEvent(new Event("controllerchange"));

		document.body.innerHTML = `
			<form>
				<input name="email" type="email">
				<input name="password" type="password">
			</form>
		`;
		const nextRegistration = new FakeServiceWorkerRegistration(null);
		const nextContainer = new FakeServiceWorkerContainer(waitingWorker, nextRegistration);
		Object.defineProperty(navigator, "serviceWorker", {configurable: true, value: nextContainer});
		await initializeApplicationUpdates({reload});
		animationFrames.shift()?.(0);

		expect({
			applicationVersion: document.documentElement.dataset["applicationVersion"],
			email: document.querySelector<HTMLInputElement>("input[name=email]")!.value,
			firstRegistration: container.registrations,
			firstUpdateCalls: registration.update.mock.calls,
			password: document.querySelector<HTMLInputElement>("input[name=password]")!.value,
			reloadCalls: reload.mock.calls,
			secondRegistration: nextContainer.registrations,
			updateEvents,
			waitingWorkerMessages: waitingWorker.messages,
		}).toStrictEqual({
			applicationVersion: APPLICATION_VERSION,
			email: "alice@example.com",
			firstRegistration: [{options: {updateViaCache: "none"}, scriptUrl: "/sw.js"}],
			firstUpdateCalls: [[], []],
			password: "",
			reloadCalls: [[]],
			secondRegistration: [{options: {updateViaCache: "none"}, scriptUrl: "/sw.js"}],
			updateEvents: 3,
			waitingWorkerMessages: [
				{type: "activate-service-worker", applicationVersion: APPLICATION_VERSION},
				{
					type: "application-version",
					applicationVersion: APPLICATION_VERSION,
					serviceWorkerVersion: "service-worker-version-n-plus-one",
				},
			],
		});
	});
});
