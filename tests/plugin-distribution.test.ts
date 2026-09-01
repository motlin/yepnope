import {spawnSync} from "node:child_process";
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {RETENTION_MILLISECONDS} from "../worker/validation";

interface PluginMcpConfig {
	mcpServers: {yepnope: {timeout: number; tool_timeout_sec: number; type: string; url: string}};
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

describe("YepNope plugin distribution", () => {
	it("publishes one Codex plugin with both skills and the remote MCP server", () => {
		expect(readJson("../plugins/yepnope/.codex-plugin/plugin.json")).toStrictEqual({
			name: "yepnope",
			version: "0.1.0",
			description: "Route every yes-or-no coding-agent question to your phone first.",
			author: {name: "YepNope"},
			homepage: "https://yepnope.app",
			repository: "https://github.com/motlin/yepnope",
			license: "MIT",
			keywords: ["codex", "claude-code", "mcp", "yes-no"],
			skills: "./skills/",
			interface: {
				displayName: "YepNope",
				shortDescription: "Answer coding-agent questions from your phone",
				longDescription:
					"Connect YepNope and try every yes-or-no coding-agent question on your phone before falling back to the native question flow.",
				developerName: "YepNope",
				category: "Productivity",
				capabilities: ["Skills", "MCP", "Hooks"],
				defaultPrompt: [
					"Use YepNope before every user-facing yes-or-no question and fall back natively only after trying it.",
					"Check whether YepNope is connected.",
				],
			},
			hooks: "./codex-hooks/hooks.json",
			mcpServers: "./.mcp.json",
		});
		expect(readJson("../plugins/yepnope/codex-hooks/hooks.json")).toStrictEqual({
			description: "Try YepNope before Codex asks the user a question.",
			hooks: {
				UserPromptSubmit: [
					{
						hooks: [
							{
								type: "command",
								command: 'node "$PLUGIN_ROOT/codex-hooks/route-questions.cjs"',
								timeout: 5,
							},
						],
					},
				],
				PreToolUse: [
					{
						matcher: "(^|__)ask_yep_nope$",
						hooks: [
							{
								type: "command",
								command: 'node "$PLUGIN_ROOT/codex-hooks/route-questions.cjs"',
								timeout: 5,
							},
						],
					},
					{
						matcher: "^(request_user_input|AskUserQuestion)$",
						hooks: [
							{
								type: "command",
								command: 'node "$PLUGIN_ROOT/codex-hooks/route-questions.cjs"',
								timeout: 5,
							},
						],
					},
				],
				PostToolUse: [
					{
						matcher: "(^|__)ask_yep_nope$",
						hooks: [
							{
								type: "command",
								command: 'node "$PLUGIN_ROOT/codex-hooks/route-questions.cjs"',
								timeout: 5,
							},
						],
					},
				],
				Stop: [
					{
						hooks: [
							{
								type: "command",
								command: 'node "$PLUGIN_ROOT/codex-hooks/route-questions.cjs"',
								timeout: 5,
							},
						],
					},
				],
			},
		});
		expect(readJson("../plugins/yepnope/.mcp.json")).toStrictEqual({
			mcpServers: {
				yepnope: {
					type: "http",
					url: "https://yepnope.app/mcp",
					timeout: 691_200_000,
					tool_timeout_sec: 691_200,
				},
			},
		});
		expect(readJson("../plugins/yepnope/.claude-plugin/plugin.json")).toStrictEqual({
			$schema: "https://anthropic.com/claude-code/plugin.schema.json",
			name: "yepnope",
			displayName: "YepNope",
			version: "0.1.0",
			description: "Route brief yes-or-no coding-agent questions to your phone.",
			author: {name: "YepNope"},
			homepage: "https://yepnope.app",
			repository: "https://github.com/motlin/yepnope",
			license: "MIT",
			keywords: ["claude-code", "codex", "mcp", "yes-no"],
			skills: ["./skills/yepnope", "./skills/yepnope-setup"],
			mcpServers: "./.mcp.json",
		});
	});

	// ⏳ `ask_yep_nope` blocks until a human answers, so whichever side gives up first decides the
	// outcome. A client that gives up first sends `notifications/cancelled`, the Worker retracts the
	// batch, and the cards vanish off the phone mid-answer while the agent collects a timeout instead
	// of a yep. Both clients therefore have to outlast the answer window the server itself enforces.
	it("ships a tool timeout that outlasts the server's own answer window", () => {
		const {yepnope} = (readJson("../plugins/yepnope/.mcp.json") as PluginMcpConfig).mcpServers;
		expect({
			claudeCodeMilliseconds: yepnope.timeout,
			codexSeconds: yepnope.tool_timeout_sec,
			clientsAgree: yepnope.timeout === yepnope.tool_timeout_sec * 1000,
			outlastsAnswerWindow: yepnope.timeout > RETENTION_MILLISECONDS,
		}).toStrictEqual({
			claudeCodeMilliseconds: 691_200_000,
			codexSeconds: 691_200,
			clientsAgree: true,
			outlastsAnswerWindow: true,
		});
	});

	it("publishes matching Claude and Codex marketplace entries", () => {
		expect(readJson("../.agents/plugins/marketplace.json")).toStrictEqual({
			name: "yepnope",
			interface: {displayName: "YepNope"},
			plugins: [
				{
					name: "yepnope",
					source: {source: "local", path: "./plugins/yepnope"},
					policy: {installation: "AVAILABLE", authentication: "ON_INSTALL"},
					category: "Productivity",
				},
			],
		});
		expect(readJson("../.claude-plugin/marketplace.json")).toStrictEqual({
			$schema: "https://anthropic.com/claude-code/marketplace.schema.json",
			name: "yepnope",
			description: "YepNope skills and remote MCP connection for coding agents.",
			owner: {name: "YepNope"},
			plugins: [
				{
					name: "yepnope",
					description: "Route brief yes-or-no coding-agent questions to your phone.",
					version: "0.1.0",
					author: {name: "YepNope"},
					source: "./plugins/yepnope",
					category: "productivity",
				},
			],
		});
	});

	it("keeps skill discovery exclusive to the plugin bundle", () => {
		expect({
			codexSetupAlias: existsSync(new URL("../.agents/skills/yepnope-setup", import.meta.url)),
			codexUseAlias: existsSync(new URL("../.agents/skills/yepnope", import.meta.url)),
			claudeSetupAlias: existsSync(new URL("../.claude/skills/yepnope-setup", import.meta.url)),
			claudeUseAlias: existsSync(new URL("../.claude/skills/yepnope", import.meta.url)),
			packagedSetup: existsSync(new URL("../plugins/yepnope/skills/yepnope-setup/SKILL.md", import.meta.url)),
			packagedUse: existsSync(new URL("../plugins/yepnope/skills/yepnope/SKILL.md", import.meta.url)),
		}).toStrictEqual({
			codexSetupAlias: false,
			codexUseAlias: false,
			claudeSetupAlias: false,
			claudeUseAlias: false,
			packagedSetup: true,
			packagedUse: true,
		});
	});

	it("documents plugin, local, and skill-only installation", () => {
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
		const setupSkill = readFileSync(
			new URL("../plugins/yepnope/skills/yepnope-setup/SKILL.md", import.meta.url),
			"utf8",
		);
		const localInstaller = readFileSync(new URL("../install-local.sh", import.meta.url), "utf8");
		expect({
			claudePlugin: readme.includes("claude plugin install yepnope@yepnope"),
			codexPlugin: readme.includes("codex plugin add yepnope@yepnope"),
			localInstaller: readme.includes("./install-local.sh all"),
			localInstallerRejectsDirectCodexRegistration:
				localInstaller.includes("mcp_servers\\.yepnope") &&
				localInstaller.includes("grep -q") &&
				localInstaller.includes("codex mcp remove yepnope"),
			npxBothSkills:
				readme.includes("npx skills add motlin/yepnope") &&
				readme.includes("--skill yepnope") &&
				readme.includes("--skill yepnope-setup"),
			setupKeepsCodexSourcesExclusive:
				setupSkill.includes("mcp_servers\\.yepnope") &&
				setupSkill.includes("rg --quiet") &&
				setupSkill.includes("Never run `codex mcp add yepnope`") &&
				setupSkill.includes("tool_timeout_sec` equal to `691200"),
		}).toStrictEqual({
			claudePlugin: true,
			codexPlugin: true,
			localInstaller: true,
			localInstallerRejectsDirectCodexRegistration: true,
			npxBothSkills: true,
			setupKeepsCodexSourcesExclusive: true,
		});
	});

	it("stops the local Codex plugin installer before a direct MCP registration can be duplicated", () => {
		const testDirectory = mkdtempSync(join(tmpdir(), "yepnope-plugin-distribution-"));
		const codexHome = join(testDirectory, "codex-home");
		const binDirectory = join(testDirectory, "bin");
		const codexMarker = join(testDirectory, "codex-invoked");

		try {
			mkdirSync(codexHome);
			mkdirSync(binDirectory);
			writeFileSync(join(codexHome, "config.toml"), '[mcp_servers.yepnope]\nurl = "https://yepnope.app/mcp"\n');
			const fakeCodex = join(binDirectory, "codex");
			writeFileSync(fakeCodex, '#!/bin/sh\nprintf invoked > "$CODEX_TEST_MARKER"\nexit 99\n');
			chmodSync(fakeCodex, 0o755);
			// 🧭 CI runners carry no ripgrep, so the installer must manage on a stock PATH. jq rides
			// along as a symlink; everything else the script may use has to come from /usr/bin and /bin.
			symlinkSync(spawnSync("which", ["jq"], {encoding: "utf8"}).stdout.trim(), join(binDirectory, "jq"));

			const result = spawnSync(
				"bash",
				[fileURLToPath(new URL("../install-local.sh", import.meta.url)), "codex"],
				{
					encoding: "utf8",
					env: {
						...process.env,
						CODEX_HOME: codexHome,
						CODEX_TEST_MARKER: codexMarker,
						PATH: `${binDirectory}:/usr/bin:/bin`,
					},
				},
			);

			expect({
				codexInvoked: existsSync(codexMarker),
				status: result.status,
				stderr: result.stderr,
			}).toStrictEqual({
				codexInvoked: false,
				status: 1,
				stderr:
					"A direct Codex MCP registration named yepnope would shadow the plugin bundle.\n" +
					"Run 'codex mcp remove yepnope' before installing the Codex plugin.\n",
			});
		} finally {
			rmSync(testDirectory, {recursive: true, force: true});
		}
	});

	it("migrates pre-OAuth client registrations without restoring the stdio shim", () => {
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
		expect({
			claudeMigration:
				readme.includes("claude mcp remove --scope local yepnope") &&
				readme.includes("claude mcp add --scope local --transport http yepnope https://yepnope.app/mcp"),
			codexMigration:
				readme.includes("codex mcp remove yepnope") &&
				readme.includes("codex mcp add yepnope --url https://yepnope.app/mcp") &&
				readme.includes("codex mcp login yepnope"),
			legacyShimCommand: readme.includes("yepnope-mcp"),
			legacyShimPath: readme.includes("shim/dist"),
		}).toStrictEqual({
			claudeMigration: true,
			codexMigration: true,
			legacyShimCommand: false,
			legacyShimPath: false,
		});
	});

	it("documents that Codex opens the authorization browser itself", () => {
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
		expect({
			namesTheVerifiedClient: readme.includes("codex-cli 0.150.1"),
			saysCodexOpensTheBrowser: readme.includes("`codex mcp login` opens the default browser itself"),
			callsThePrintedUrlAFallback: readme.includes(
				"Copy the printed URL by hand only when that launch cannot work",
			),
		}).toStrictEqual({
			namesTheVerifiedClient: true,
			saysCodexOpensTheBrowser: true,
			callsThePrintedUrlAFallback: true,
		});
	});

	it("documents the timeout the plugin ships instead of one the reader must set", () => {
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
		expect({
			staleTwelveHourAdvice: readme.includes("43200000"),
			namesClaudeCodeKey: readme.includes('"timeout": 691200000'),
			namesCodexKey: readme.includes('"tool_timeout_sec": 691200'),
		}).toStrictEqual({
			staleTwelveHourAdvice: false,
			namesClaudeCodeKey: true,
			namesCodexKey: true,
		});
	});

	it("does not package status-line ownership or background polling", () => {
		const distribution = [
			readFileSync(new URL("../install-local.sh", import.meta.url), "utf8"),
			readFileSync(new URL("../plugins/yepnope/.codex-plugin/plugin.json", import.meta.url), "utf8"),
			readFileSync(new URL("../plugins/yepnope/.claude-plugin/plugin.json", import.meta.url), "utf8"),
			readFileSync(new URL("../plugins/yepnope/.mcp.json", import.meta.url), "utf8"),
		].join("\n");

		expect({
			refreshInterval: distribution.includes("refreshInterval"),
			statusLineSetting: distribution.includes('"statusLine"'),
		}).toStrictEqual({
			refreshInterval: false,
			statusLineSetting: false,
		});
	});
});
