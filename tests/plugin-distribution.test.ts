import {existsSync, readFileSync} from "node:fs";
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
			description: "Route brief yes-or-no coding-agent questions to your phone.",
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
					"Connect YepNope and route brief yes-or-no coding-agent questions to your phone without taking over a status line.",
				developerName: "YepNope",
				category: "Productivity",
				capabilities: ["Skills", "MCP"],
				defaultPrompt: [
					"Use YepNope first for a blocking yes-or-no question, with native fallback.",
					"Check whether YepNope is connected.",
				],
			},
			mcpServers: "./.mcp.json",
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
		expect({
			claudePlugin: readme.includes("claude plugin install yepnope@yepnope"),
			codexPlugin: readme.includes("codex plugin add yepnope@yepnope"),
			localInstaller: readme.includes("./install-local.sh all"),
			npxBothSkills:
				readme.includes("npx skills add motlin/yepnope") &&
				readme.includes("--skill yepnope") &&
				readme.includes("--skill yepnope-setup"),
		}).toStrictEqual({
			claudePlugin: true,
			codexPlugin: true,
			localInstaller: true,
			npxBothSkills: true,
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
