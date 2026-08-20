import {resolve} from "node:path";
import {expect, test, type Page} from "playwright/test";
import {fulfillJson} from "./helpers";

const screenshotDirectory = resolve(import.meta.dirname, "../../.llm/screenshots");

interface Color {
	alpha: number;
	blue: number;
	green: number;
	red: number;
}

function parseColor(value: string): Color {
	const match = value.match(/^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/);
	if (match === null) {
		throw new Error(`Unsupported CSS color: ${value}`);
	}
	return {
		alpha: match[4] === undefined ? 1 : Number(match[4]),
		blue: Number(match[3]),
		green: Number(match[2]),
		red: Number(match[1]),
	};
}

function compositeColor(foreground: Color, background: Color): Color {
	return {
		alpha: 1,
		blue: foreground.blue * foreground.alpha + background.blue * (1 - foreground.alpha),
		green: foreground.green * foreground.alpha + background.green * (1 - foreground.alpha),
		red: foreground.red * foreground.alpha + background.red * (1 - foreground.alpha),
	};
}

function relativeLuminance(color: Color): number {
	const channelLuminance = (channel: number): number => {
		const normalized = channel / 255;
		return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
	};
	return (
		0.2126 * channelLuminance(color.red) +
		0.7152 * channelLuminance(color.green) +
		0.0722 * channelLuminance(color.blue)
	);
}

function contrastRatio(foreground: Color, background: Color): number {
	const foregroundLuminance = relativeLuminance(foreground);
	const backgroundLuminance = relativeLuminance(background);
	return (
		(Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
		(Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
	);
}

async function routeAfkDeck(page: Page, afk: boolean | null): Promise<void> {
	let afkRequestCount = 0;
	await page.route("**/api/auth/get-session", async (route) =>
		fulfillJson(route, {user: {id: "user-alice", email: "alice@example.com", emailVerified: true}}),
	);
	await page.route("**/api/v1/afk", async (route) => {
		afkRequestCount += 1;
		if (afk === null && afkRequestCount > 1) {
			await route.abort("timedout");
			return;
		}
		await fulfillJson(route, {afk: afk ?? false});
	});
	await page.routeWebSocket("**/api/v1/current-deck/stream", (socket) => {
		socket.send(
			JSON.stringify({
				type: "current_deck",
				afk: afk ?? false,
				connected_mcp_client_count: 1,
				current_deck: [],
			}),
		);
	});
	await page.goto("/");
	await expect(page.getByRole("button", {name: "1 MCP client authorized"})).toBeVisible();
	if (afk === null) {
		await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
	}
}

async function assertTextContrast(page: Page, buttonName: string): Promise<void> {
	const colors = await page.getByRole("button", {name: buttonName}).evaluate((element) => {
		const style = getComputedStyle(element);
		return {
			background: style.backgroundColor,
			bodyBackground: getComputedStyle(document.body).backgroundColor,
			text: style.color,
		};
	});
	const renderedBackground = compositeColor(parseColor(colors.background), parseColor(colors.bodyBackground));
	expect(contrastRatio(parseColor(colors.text), renderedBackground)).toBeGreaterThanOrEqual(4.5);
}

test("AFK off is a neutral available toggle with hover and pressed feedback", async ({page}) => {
	await routeAfkDeck(page, false);
	const toggle = page.getByRole("button", {name: "AFK off"});
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	expect(
		await toggle.evaluate((element) => {
			const style = getComputedStyle(element);
			return {
				backgroundColor: style.backgroundColor,
				borderColor: style.borderColor,
				className: element.getAttribute("class"),
				color: style.color,
				cursor: style.cursor,
				disabled: (element as HTMLButtonElement).disabled,
			};
		}),
	).toStrictEqual({
		backgroundColor: "rgba(255, 255, 255, 0.04)",
		borderColor: "rgb(98, 104, 115)",
		className: "afk-toggle afk-off",
		color: "rgb(185, 190, 199)",
		cursor: "pointer",
		disabled: false,
	});
	await assertTextContrast(page, "AFK off");
	await page.screenshot({fullPage: true, path: resolve(screenshotDirectory, "afk-off.png")});

	await toggle.hover();
	expect(
		await toggle.evaluate((element) => {
			const style = getComputedStyle(element);
			return {backgroundColor: style.backgroundColor, borderColor: style.borderColor, color: style.color};
		}),
	).toStrictEqual({
		backgroundColor: "rgba(255, 255, 255, 0.08)",
		borderColor: "rgb(143, 150, 161)",
		color: "rgb(236, 238, 242)",
	});
	const bounds = await toggle.boundingBox();
	if (bounds === null) {
		throw new Error("AFK toggle bounds are missing");
	}
	await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
	await page.mouse.down();
	expect(
		await toggle.evaluate((element) => {
			const style = getComputedStyle(element);
			return {backgroundColor: style.backgroundColor, transform: style.transform};
		}),
	).toStrictEqual({backgroundColor: "rgba(255, 255, 255, 0.12)", transform: "matrix(1, 0, 0, 1, 0, 1)"});
	await page.mouse.up();
});

test("AFK on uses the healthy green pressed treatment", async ({page}) => {
	await routeAfkDeck(page, true);
	const toggle = page.getByRole("button", {name: "AFK on"});
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	expect(
		await toggle.evaluate((element) => {
			const style = getComputedStyle(element);
			return {
				backgroundColor: style.backgroundColor,
				borderColor: style.borderColor,
				className: element.getAttribute("class"),
				color: style.color,
				disabled: (element as HTMLButtonElement).disabled,
			};
		}),
	).toStrictEqual({
		backgroundColor: "rgba(46, 184, 114, 0.16)",
		borderColor: "rgb(46, 184, 114)",
		className: "afk-toggle afk-on",
		color: "rgb(46, 184, 114)",
		disabled: false,
	});
	await assertTextContrast(page, "AFK on");
	await page.screenshot({fullPage: true, path: resolve(screenshotDirectory, "afk-on.png")});
});

test("AFK checking is a calm busy disabled state", async ({page}) => {
	await routeAfkDeck(page, null);
	const toggle = page.getByRole("button", {name: "Checking AFK…"});
	await expect(toggle).toBeDisabled();
	expect(
		await toggle.evaluate((element) => {
			const style = getComputedStyle(element);
			return {
				ariaBusy: element.getAttribute("aria-busy"),
				ariaPressed: element.getAttribute("aria-pressed"),
				backgroundColor: style.backgroundColor,
				borderColor: style.borderColor,
				borderStyle: style.borderStyle,
				className: element.getAttribute("class"),
				color: style.color,
				cursor: style.cursor,
			};
		}),
	).toStrictEqual({
		ariaBusy: "true",
		ariaPressed: null,
		backgroundColor: "rgba(255, 255, 255, 0.02)",
		borderColor: "rgb(65, 69, 78)",
		borderStyle: "dashed",
		className: "afk-toggle afk-checking",
		color: "rgb(143, 150, 161)",
		cursor: "progress",
	});
	await page.screenshot({fullPage: true, path: resolve(screenshotDirectory, "afk-checking.png")});
});

test("AFK toggle exposes a visible keyboard focus ring", async ({page}) => {
	await routeAfkDeck(page, false);
	await page.keyboard.press("Tab");
	await expect(page.getByRole("button", {name: "1 MCP client authorized"})).toBeFocused();
	await page.keyboard.press("Tab");
	const toggle = page.getByRole("button", {name: "AFK off"});
	await expect(toggle).toBeFocused();
	expect(
		await toggle.evaluate((element) => {
			const style = getComputedStyle(element);
			return {
				outlineColor: style.outlineColor,
				outlineOffset: style.outlineOffset,
				outlineStyle: style.outlineStyle,
				outlineWidth: style.outlineWidth,
			};
		}),
	).toStrictEqual({
		outlineColor: "rgb(215, 218, 224)",
		outlineOffset: "2px",
		outlineStyle: "solid",
		outlineWidth: "2px",
	});
	await page.screenshot({fullPage: true, path: resolve(screenshotDirectory, "afk-keyboard-focus.png")});
});

test("AFK controls remain readable within a narrow mobile header", async ({browser}) => {
	const context = await browser.newContext({
		ignoreHTTPSErrors: true,
		isMobile: true,
		viewport: {height: 568, width: 320},
	});
	const page = await context.newPage();
	try {
		await routeAfkDeck(page, true);
		const headerBounds = await page.locator(".app-header").boundingBox();
		const toggleBounds = await page.getByRole("button", {name: "AFK on"}).boundingBox();
		if (headerBounds === null || toggleBounds === null) {
			throw new Error("narrow AFK header bounds are missing");
		}
		expect(await page.locator(".app-header").evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(288);
		expect(toggleBounds.x).toBeGreaterThanOrEqual(headerBounds.x);
		expect(toggleBounds.x + toggleBounds.width).toBeLessThanOrEqual(headerBounds.x + headerBounds.width);
		await expect(page.getByRole("button", {name: "AFK on"})).toHaveAttribute("aria-pressed", "true");
		await page.screenshot({fullPage: true, path: resolve(screenshotDirectory, "afk-narrow-mobile.png")});
	} finally {
		await context.close();
	}
});
