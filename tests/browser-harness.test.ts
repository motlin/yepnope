import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import playwrightConfig from "../playwright.config";
import viteConfig from "../vite.config";
import {
	BROWSER_TEST_PREPARE_COMMAND,
	BROWSER_TEST_SERVE_COMMAND,
	PREPARE_COMMANDS,
	SERVE_COMMAND,
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

describe("browser test harness", () => {
	it("builds the Worker and migrates its database while preparing, not while serving", () => {
		expect(PREPARE_COMMANDS.map(commandLine)).toEqual([
			"vp build",
			expect.stringContaining("wrangler d1 migrations apply DB"),
		]);
		expect(commandLine(SERVE_COMMAND)).toContain("wrangler dev");
		expect(SERVE_COMMAND.arguments_).not.toContain("build");
	});

	it("hands Playwright a web server that only serves", () => {
		expect(playwrightConfig.webServer).toMatchObject({command: BROWSER_TEST_SERVE_COMMAND});
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
