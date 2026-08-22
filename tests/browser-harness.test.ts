import {readdirSync, readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import playwrightConfig from "../playwright.config";
import viteConfig from "../vite.config";
import {
	BROWSER_TEST_PREPARE_COMMAND,
	BROWSER_TEST_SERVE_COMMAND,
	INITIAL_APPLICATION_VERSION,
	PREPARE_COMMANDS,
	SERVE_COMMAND,
	UPGRADED_APPLICATION_VERSION,
	type HarnessCommand,
} from "../scripts/browser-test-harness";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	scripts: Record<string, string>;
};

function taskCommand(task: unknown): string {
	if (typeof task === "object" && task !== null && "command" in task && typeof task.command === "string") {
		return task.command;
	}
	throw new Error("every Vite task in this repository is declared with a single string command");
}

const taskCommands = Object.values(viteConfig.run?.tasks ?? {}).map(taskCommand);

// Every shell command this repository offers that can end up running the local browser suite.
const entryPointCommands = [...Object.values(packageJson.scripts), ...taskCommands];

function commandLine(command: HarnessCommand): string {
	return [command.command, ...command.arguments_].join(" ");
}

const browserSpecDirectory = new URL("browser/", import.meta.url);

describe("browser test harness", () => {
	it("builds the Worker and migrates its database while preparing, not while serving", () => {
		expect(PREPARE_COMMANDS.map(commandLine)).toEqual([
			"vp build",
			"vp build",
			expect.stringContaining("wrangler d1 migrations apply DB"),
		]);
		expect(commandLine(SERVE_COMMAND)).toContain("wrangler dev");
		expect(SERVE_COMMAND.arguments_).not.toContain("build");
	});

	// 🧱 The upgrade the service worker spec proves needs a second client build. Building it while
	// the suite runs rewrote the directory `wrangler dev` serves and watches, which reloaded the
	// Worker — discarding its in-memory state and failing whichever request was in flight — under
	// whichever spec happened to be running when the reload landed. Both versions are built up
	// front instead, into directories that do not overlap.
	it("builds both client versions up front, each into its own directory", () => {
		expect(
			PREPARE_COMMANDS.filter(({command, arguments_}) => command === "vp" && arguments_[0] === "build").map(
				({environment}) => environment,
			),
		).toEqual([
			{
				VITE_APPLICATION_VERSION: UPGRADED_APPLICATION_VERSION,
				VITE_BUILD_OUT_DIR: expect.stringContaining("browser-e2e-upgraded-client"),
			},
			{VITE_APPLICATION_VERSION: INITIAL_APPLICATION_VERSION},
		]);
	});

	it("leaves every spec out of the business of running build commands", () => {
		const specsRunningCommands = readdirSync(browserSpecDirectory)
			.filter((name) => name.endsWith(".spec.ts"))
			.filter((name) => readFileSync(new URL(name, browserSpecDirectory), "utf8").includes("node:child_process"));
		expect(specsRunningCommands).toEqual([]);
	});

	it("hands Playwright a web server that only serves", () => {
		expect(playwrightConfig.webServer).toMatchObject({command: BROWSER_TEST_SERVE_COMMAND});
	});

	// Playwright stops watching the web server once it has started, so a server that dies mid-run
	// is reported as dozens of refused connections and reads as a product regression. The reporter
	// is what draws that distinction, and it can only draw it from a log the server actually keeps.
	it("keeps the server's own account of the run, and reads it back when the server dies", () => {
		expect(SERVE_COMMAND.arguments_).toEqual(expect.arrayContaining(["--log-level", "log"]));
		expect(playwrightConfig.reporter).toContainEqual(["./scripts/browser-test-reporter.ts"]);
		expect(readFileSync(new URL("../scripts/browser-test-server.ts", import.meta.url), "utf8")).toContain(
			"SERVER_EXITED_MARKER",
		);
	});

	// The whole point of the split: a cold `vp build` runs with no Playwright timeout above it.
	// Any entry point that reaches playwright.config.ts must therefore prepare first, or the web
	// server it starts has nothing built to serve.
	it("prepares before every entry point that runs the local browser suite", () => {
		const browserSuiteCommands = entryPointCommands.filter((command) =>
			command.includes("--config playwright.config.ts"),
		);
		expect(browserSuiteCommands).toHaveLength(1);
		for (const command of browserSuiteCommands) {
			expect(command.indexOf(BROWSER_TEST_PREPARE_COMMAND)).toBeGreaterThanOrEqual(0);
			expect(command.indexOf(BROWSER_TEST_PREPARE_COMMAND)).toBeLessThan(command.indexOf("playwright/cli.js"));
		}
	});

	it("reaches the browser suite from the task that runs every test", () => {
		expect(viteConfig.run?.tasks?.["test:run"]).toMatchObject({
			command: expect.stringContaining("vp run test:browser"),
		});
	});
});
