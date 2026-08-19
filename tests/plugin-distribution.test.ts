import {existsSync, readFileSync} from "node:fs";

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
				defaultPrompt: ["Use YepNope to ask me a yes-or-no question.", "Check whether YepNope is connected."],
			},
			mcpServers: "./.mcp.json",
		});
		expect(readJson("../plugins/yepnope/.mcp.json")).toStrictEqual({
			mcpServers: {
				yepnope: {
					type: "http",
					url: "https://yepnope.app/mcp",
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
