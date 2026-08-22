import {defineConfig} from "playwright/test";
import {BROWSER_TEST_SERVE_COMMAND, SERVER_ORIGIN} from "./scripts/browser-test-harness.ts";

export default defineConfig({
	testDir: "./tests/browser",
	outputDir: ".llm/playwright-results",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 90_000,
	expect: {timeout: 10_000},
	// The JSON report is the other half of the timestamped server log: it says when each spec ran,
	// so a failure can be read against what `wrangler dev` was doing at that moment. The third
	// reporter reads that log back and says when the server, not the product, is what failed.
	reporter: [["line"], ["json", {outputFile: ".llm/playwright-report.json"}], ["./scripts/browser-test-reporter.ts"]],
	use: {
		baseURL: SERVER_ORIGIN,
		browserName: "chromium",
		headless: true,
		ignoreHTTPSErrors: true,
		launchOptions: {args: ["--ignore-certificate-errors"]},
		trace: "off",
		screenshot: "off",
		video: "off",
	},
	// 🖥️ The local suite. `vp run test:browser` builds the client and migrates the database first,
	// so this timeout only has to cover `wrangler dev` binding the port, not a cold build.
	webServer: {
		command: BROWSER_TEST_SERVE_COMMAND,
		url: SERVER_ORIGIN,
		gracefulShutdown: {signal: "SIGTERM", timeout: 5_000},
		ignoreHTTPSErrors: true,
		reuseExistingServer: false,
		stdout: "ignore",
		stderr: "pipe",
		timeout: 120_000,
	},
});
