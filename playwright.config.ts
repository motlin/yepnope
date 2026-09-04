import {defineConfig} from "playwright/test";
import {BROWSER_TEST_SERVE_COMMAND, SERVER_ORIGIN} from "./scripts/browser-test-harness.ts";

export default defineConfig({
	testDir: "./tests/browser",
	outputDir: ".llm/playwright-results",
	// 🧵 Spec files run alongside each other; the tests inside one still run in order, so the specs
	// that reuse an account across their own tests keep the sequence they were written for. Sharing
	// one server is safe because every spec that reaches it owns its accounts: the dynamic ones mint
	// a UUID address and the fixed ones are unique to their file.
	fullyParallel: false,
	workers: 6,
	retries: 0,
	timeout: 90_000,
	expect: {timeout: 10_000},
	// The JSON report is the other half of the timestamped server log: it says when each spec ran,
	// so a failure can be read against what `wrangler dev` was doing at that moment. The third
	// reporter reads that log back and says when the server, not the product, is what failed.
	reporter: [["line"], ["json", {outputFile: ".llm/playwright-report.json"}], ["./scripts/browser-test-reporter.ts"]],
	// 🔀 Two specs still cannot share the run, so each is a project of its own and `dependencies`
	// puts them after the parallel middle:
	//   `turnstile` reconfigures human verification server-wide through `/api/__e2e__/turnstile`,
	//     which every other spec's sign-up would otherwise see.
	//   `service-worker-upgrade` writes over the client directory the server serves and watches, and
	//     the reload that follows would land on whichever spec happened to be mid-request.
	// Everything else owns its own accounts and runs together in `app`.
	projects: [
		{
			name: "app",
			testIgnore: ["**/turnstile.spec.ts", "**/service-worker-upgrade.spec.ts"],
		},
		{name: "turnstile", testMatch: "**/turnstile.spec.ts", dependencies: ["app"]},
		{name: "upgrade", testMatch: "**/service-worker-upgrade.spec.ts", dependencies: ["turnstile"]},
	],
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
