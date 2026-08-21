import {defineConfig} from "playwright/test";
import {DEPLOYMENT_ORIGIN_VARIABLE} from "./scripts/deployment-check.ts";

// 🌍 The deployed suite. Unlike `playwright.config.ts` there is no `webServer`: the Worker under
// test is already running on Cloudflare, its certificate is real, and its latency is real, so the
// timeouts are generous enough for a WebSocket round trip across the internet plus the deck's own
// five-second undo window. `scripts/deployment-check.ts` is the supported entry point; it decides
// which origin this is allowed to point at and hands the run its automation passkey.
export default defineConfig({
	testDir: "./tests/deployed",
	outputDir: ".llm/playwright-deployed-results",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 240_000,
	expect: {timeout: 30_000},
	reporter: [["line"]],
	use: {
		baseURL: process.env[DEPLOYMENT_ORIGIN_VARIABLE],
		browserName: "chromium",
		headless: true,
		trace: "off",
		screenshot: "off",
		video: "off",
	},
});
