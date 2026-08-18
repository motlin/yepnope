import {spawnSync} from "node:child_process";
import {resolve} from "node:path";
import {expect, test, type Page, type Route} from "playwright/test";

const repositoryDirectory = resolve(import.meta.dirname, "../..");

function buildApplicationVersion(version: string): void {
	const result = spawnSync("vp", ["build"], {
		cwd: repositoryDirectory,
		encoding: "utf8",
		env: {...process.env, CI: "true", VITE_APPLICATION_VERSION: version},
	});
	if (result.status !== 0) {
		throw new Error(`version ${version} build failed\n${result.stdout}\n${result.stderr}`);
	}
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
	await route.fulfill({json: body});
}

async function routeAuthenticatedApplication(page: Page): Promise<void> {
	await page.route("**/api/auth/get-session", async (route) =>
		fulfillJson(route, {
			user: {
				id: "user-alice",
				name: "Alice",
				email: "alice@example.com",
				emailVerified: true,
			},
		}),
	);
	await page.route("**/api/v1/afk", async (route) => fulfillJson(route, {afk: false}));
	await page.route("**/api/v1/pair/status", async (route) => fulfillJson(route, {paired: true, machine_count: 1}));
}

test("activates version N+1 and stops version N JavaScript and its socket", async ({page}) => {
	await routeAuthenticatedApplication(page);
	let oldJavaScriptTicks = 0;
	await page.exposeFunction("recordOldJavaScriptTick", () => {
		oldJavaScriptTicks += 1;
	});
	await page.addInitScript(() => {
		const nextDocumentNumber = Number(sessionStorage.getItem("browser-test-document-number") ?? "0") + 1;
		sessionStorage.setItem("browser-test-document-number", String(nextDocumentNumber));
	});

	let socketConnections = 0;
	const closedSocketNumbers = new Set<number>();
	await page.routeWebSocket("**/api/v1/current-deck/stream", (socket) => {
		socketConnections += 1;
		const socketNumber = socketConnections;
		socket.onClose(() => {
			closedSocketNumbers.add(socketNumber);
		});
		socket.send(
			JSON.stringify({
				type: "current_deck",
				afk: false,
				paired: true,
				machine_count: 1,
				current_deck: [],
			}),
		);
	});

	await page.goto("/");
	await expect(page.locator("html")).toHaveAttribute("data-application-version", "browser-version-n");
	await expect
		.poll(async () => page.evaluate(async () => (await navigator.serviceWorker.getRegistration()) !== undefined))
		.toBe(true);
	await page.evaluate(async () => navigator.serviceWorker.ready);
	await expect.poll(() => socketConnections).toBe(1);
	await page.evaluate(() => {
		const recordTick = (window as unknown as {recordOldJavaScriptTick: () => void}).recordOldJavaScriptTick;
		window.setInterval(recordTick, 25);
	});
	await expect.poll(() => oldJavaScriptTicks).toBeGreaterThan(2);

	buildApplicationVersion("browser-version-n-plus-one");
	await page.evaluate(async () => {
		const registration = await navigator.serviceWorker.getRegistration();
		if (registration === undefined) {
			throw new Error("service worker registration is missing");
		}
		await registration.update();
		document.dispatchEvent(new Event("visibilitychange"));
	});

	await expect(page.locator("html")).toHaveAttribute("data-application-version", "browser-version-n-plus-one");
	await expect.poll(() => socketConnections).toBe(2);
	await expect.poll(() => closedSocketNumbers.has(1)).toBe(true);
	await page.waitForTimeout(100);
	const stoppedJavaScriptTickCount = oldJavaScriptTicks;
	await page.waitForTimeout(150);

	expect({
		closedSocketNumbers,
		documentNumber: await page.evaluate(() => sessionStorage.getItem("browser-test-document-number")),
		oldJavaScriptTicks,
		socketConnections,
		stoppedJavaScriptTickCount,
	}).toStrictEqual({
		closedSocketNumbers: new Set([1]),
		documentNumber: "2",
		oldJavaScriptTicks: stoppedJavaScriptTickCount,
		socketConnections: 2,
		stoppedJavaScriptTickCount,
	});
});
