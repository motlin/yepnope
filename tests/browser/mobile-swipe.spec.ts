import {expect, test, type CDPSession, type Page} from "playwright/test";
import {FLY_OUT_MILLISECONDS, UNDO_WINDOW_MILLISECONDS} from "../../src/deck";
import {fulfillJson} from "./helpers";

// 📱 The touch half of src/deck.tsx at a phone-sized viewport: a one-finger swipe is held for the
// undo window before it is posted, and a two-finger pinch is never read as a swipe. Real touch
// events come from CDP so the browser's own touch-to-pointer path is what gets exercised; the
// emulated viewport cannot prove the pinch actually zooms, which is what
// .llm/phone-verification-checklist.md covers on a real device.

/** Partway into the undo window, where the answer must still be unposted. */
const EARLY_CHECK_MILLISECONDS = 3_000;
/** How long a spec waits past the window before it accepts that nothing was ever posted. */
const PAST_WINDOW_MILLISECONDS = UNDO_WINDOW_MILLISECONDS + 1_000;
/** Slack on the measured hold, so scheduler jitter alone cannot fail the spec. */
const HOLD_TOLERANCE_MILLISECONDS = 500;
/** Twice the fly-out, so a card still on screen afterwards really did stay put. */
const FLY_OUT_GRACE_MILLISECONDS = FLY_OUT_MILLISECONDS * 2;
const GESTURE_STEPS = 8;
/** Each pinch step pushes both fingers this much further from the card's center. */
const PINCH_SPREAD_PIXELS = 20;

test.use({
	viewport: {width: 390, height: 664},
	deviceScaleFactor: 3,
	isMobile: true,
	hasTouch: true,
});

interface TouchPoint {
	x: number;
	y: number;
}

interface AnswerPost {
	body: unknown;
	at: number;
}

function question(index: number, title: string): Record<string, unknown> {
	return {
		batch_id: "batch-mobile",
		project: "Mobile swipe",
		repo: "yepnope",
		branch: "main",
		worktree: null,
		directory: null,
		question_id: `question-${index}`,
		position: index,
		title,
		body: "Swipe right for yep, left for nope, down for skip.",
		created_at: 946_684_800_000,
	};
}

async function routeMobileDeck(page: Page): Promise<AnswerPost[]> {
	const answers: AnswerPost[] = [];
	await page.route("**/api/auth/get-session", async (route) =>
		fulfillJson(route, {user: {id: "user-alice", email: "alice@example.com", emailVerified: true}}),
	);
	await page.route("**/api/v1/afk", async (route) => fulfillJson(route, {afk: false}));
	await page.route("**/api/v1/answers", async (route) => {
		answers.push({body: route.request().postDataJSON(), at: Date.now()});
		await fulfillJson(route, {status: "ok"});
	});
	await page.routeWebSocket("**/api/v1/current-deck/stream", (socket) => {
		socket.send(
			JSON.stringify({
				type: "current_deck",
				afk: false,
				connected_mcp_client_count: 1,
				current_deck: [
					question(1, "Approve the mobile swipe change?"),
					question(2, "Reject the mobile swipe risk?"),
					question(3, "Defer the mobile pinch check?"),
				],
			}),
		);
	});
	await page.goto("/");
	await expect(page.getByRole("heading", {name: "Approve the mobile swipe change?"})).toBeVisible();
	return answers;
}

async function cardCenter(page: Page): Promise<TouchPoint> {
	const box = await page.locator(".card").boundingBox();
	if (box === null) {
		throw new Error("the card has no bounding box");
	}
	return {x: box.x + box.width / 2, y: box.y + box.height / 2};
}

async function dispatchTouch(
	session: CDPSession,
	type: "touchStart" | "touchMove" | "touchEnd",
	points: TouchPoint[],
): Promise<void> {
	await session.send("Input.dispatchTouchEvent", {
		type,
		touchPoints: points.map((point, id) => ({x: point.x, y: point.y, id})),
	});
}

/** One finger down on the card, dragged by (dx, dy) in a few steps, then lifted. */
async function swipe(page: Page, session: CDPSession, dx: number, dy: number): Promise<void> {
	const start = await cardCenter(page);
	await dispatchTouch(session, "touchStart", [start]);
	for (let step = 1; step <= GESTURE_STEPS; step += 1) {
		await dispatchTouch(session, "touchMove", [
			{x: start.x + (dx * step) / GESTURE_STEPS, y: start.y + (dy * step) / GESTURE_STEPS},
		]);
	}
	await dispatchTouch(session, "touchEnd", []);
}

/** Two fingers on the card spreading apart, the way a zoom-in pinch lands. */
async function pinchOut(page: Page, session: CDPSession): Promise<void> {
	const center = await cardCenter(page);
	const fingers = (spread: number): TouchPoint[] => [
		{x: center.x - spread, y: center.y - spread / 2},
		{x: center.x + spread, y: center.y + spread / 2},
	];
	await dispatchTouch(session, "touchStart", fingers(PINCH_SPREAD_PIXELS));
	for (let step = 1; step <= GESTURE_STEPS; step += 1) {
		await dispatchTouch(session, "touchMove", fingers(PINCH_SPREAD_PIXELS * (step + 1)));
	}
	await dispatchTouch(session, "touchEnd", []);
}

test("a one-finger swipe is held for the undo window before it is posted", async ({page}) => {
	const answers = await routeMobileDeck(page);
	const session = await page.context().newCDPSession(page);

	await swipe(page, session, 200, -20);
	// Read before the assertions below, so only the gesture's own latency eats into the tolerance.
	const heldAt = Date.now();
	await expect(page.getByRole("status")).toHaveText("Yep recorded");
	await expect(page.getByText(/^[45]s to undo$/)).toBeVisible();
	await expect(page.getByRole("heading", {name: "Reject the mobile swipe risk?"})).toBeVisible();

	await page.waitForTimeout(EARLY_CHECK_MILLISECONDS);
	expect(answers).toStrictEqual([]);
	await expect(page.getByRole("button", {name: "Undo yep"})).toBeVisible();

	await expect.poll(() => answers.length, {timeout: UNDO_WINDOW_MILLISECONDS * 2}).toBe(1);
	const [posted] = answers;
	if (posted === undefined) {
		throw new Error("the answer was never posted");
	}
	expect(posted.at - heldAt).toBeGreaterThanOrEqual(UNDO_WINDOW_MILLISECONDS - HOLD_TOLERANCE_MILLISECONDS);
	expect(posted.body).toStrictEqual({answers: [{question_id: "question-1", disposition: "yep"}]});
	await expect(page.getByRole("button", {name: "Undo yep"})).toBeHidden();
});

test("tapping Undo inside the window brings the card back and posts nothing", async ({page}) => {
	const answers = await routeMobileDeck(page);
	const session = await page.context().newCDPSession(page);

	await swipe(page, session, -200, -20);
	await expect(page.getByRole("status")).toHaveText("Nope recorded");
	await expect(page.getByRole("heading", {name: "Reject the mobile swipe risk?"})).toBeVisible();

	await page.getByRole("button", {name: "Undo nope"}).tap();
	await expect(page.getByRole("heading", {name: "Approve the mobile swipe change?"})).toBeVisible();
	await expect(page.getByRole("button", {name: "Undo nope"})).toBeHidden();
	await expect(page.locator(".deck-header .count")).toHaveText("1 of 3");

	await page.waitForTimeout(PAST_WINDOW_MILLISECONDS);
	expect(answers).toStrictEqual([]);
});

test("the page leaves pinch-zoom to the browser", async ({page}) => {
	await routeMobileDeck(page);
	expect(await page.locator("meta[name=viewport]").getAttribute("content")).not.toMatch(
		/user-scalable\s*=\s*(no|0)|maximum-scale/,
	);
	expect(await page.locator(".card").evaluate((card) => getComputedStyle(card).touchAction)).toBe("pinch-zoom");
});

test("a two-finger pinch on the card is not a swipe", async ({page}) => {
	const answers = await routeMobileDeck(page);
	const session = await page.context().newCDPSession(page);

	await pinchOut(page, session);
	await page.waitForTimeout(FLY_OUT_GRACE_MILLISECONDS);
	await expect(page.getByRole("heading", {name: "Approve the mobile swipe change?"})).toBeVisible();
	await expect(page.locator(".undo-bar")).toHaveCount(0);
	expect(
		await page.locator(".card").evaluate((card) => ({
			// The first finger opens a drag the second one abandons, so a spring-back is fine;
			// a drag or a fly-out is not.
			classes: [...card.classList].filter((name) => name !== "springing"),
			stamps: [...card.querySelectorAll(".stamp")].map((stamp) => getComputedStyle(stamp).opacity),
			transform: getComputedStyle(card).transform,
		})),
	).toStrictEqual({classes: ["card"], stamps: ["0", "0", "0"], transform: "none"});
	expect(answers).toStrictEqual([]);

	// A lone finger after the pinch still swipes, so the second-finger guard released its state.
	await swipe(page, session, 0, 200);
	await expect(page.getByRole("status")).toHaveText("Skip recorded");
});
