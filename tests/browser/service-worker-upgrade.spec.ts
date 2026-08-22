import {expect, test, type Page} from "playwright/test";
import {
	INITIAL_APPLICATION_VERSION,
	serveUpgradedClient,
	UPGRADED_APPLICATION_VERSION,
} from "../../scripts/browser-test-harness";
import {fulfillJson, waitForServerToSettle} from "./helpers";

// 🔁 The upgrade this spec proves is a directory swap, not a build. Both versions were built before
// Playwright started, so the only thing that happens mid-suite is the swap itself — and this spec
// waits for the reload that follows it, rather than letting it land on a later spec.
test.afterEach(async ({request}) => {
	await waitForServerToSettle(request);
});

async function routeAuthenticatedApplication(page: Page): Promise<void> {
	await page.route("**/api/auth/get-session", async (route) =>
		fulfillJson(route, {
			user: {
				id: "user-alice",
				email: "alice@example.com",
				emailVerified: true,
			},
		}),
	);
	await page.route("**/api/v1/afk", async (route) => fulfillJson(route, {afk: false}));
}

test("activates version N+1 and stops version N JavaScript and its socket", async ({page, request}) => {
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
				connected_mcp_client_count: 1,
				current_deck: [],
			}),
		);
	});

	await page.goto("/");
	await expect(page.locator("html")).toHaveAttribute("data-application-version", INITIAL_APPLICATION_VERSION);
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

	serveUpgradedClient();
	// The server reloads onto the new client on its own schedule, and a service worker that goes
	// looking before it has finds the old files and keeps them. So wait for the reload, and say out
	// loud that the new client is the one being served before asking the page to notice.
	await waitForServerToSettle(request);
	expect(await (await request.get("/sw.js")).text()).toContain(UPGRADED_APPLICATION_VERSION);

	await page.evaluate(async () => {
		const registration = await navigator.serviceWorker.getRegistration();
		if (registration === undefined) {
			throw new Error("service worker registration is missing");
		}
		await registration.update();
		document.dispatchEvent(new Event("visibilitychange"));
	});

	await expect(page.locator("html")).toHaveAttribute("data-application-version", UPGRADED_APPLICATION_VERSION);
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
