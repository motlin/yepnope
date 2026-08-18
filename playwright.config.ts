import {defineConfig} from "playwright/test";

const serverOrigin = "https://127.0.0.1:4173";

export default defineConfig({
	testDir: "./tests/browser",
	outputDir: ".llm/playwright-results",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 90_000,
	expect: {timeout: 10_000},
	reporter: [["line"]],
	use: {
		baseURL: serverOrigin,
		browserName: "chromium",
		headless: true,
		ignoreHTTPSErrors: true,
		trace: "off",
		screenshot: "off",
		video: "off",
	},
	webServer: {
		command: "node scripts/browser-test-server.ts",
		url: serverOrigin,
		gracefulShutdown: {signal: "SIGTERM", timeout: 5_000},
		ignoreHTTPSErrors: true,
		reuseExistingServer: false,
		stdout: "ignore",
		stderr: "pipe",
		timeout: 120_000,
	},
});
