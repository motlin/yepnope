import assert from "node:assert/strict";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {join, resolve, sep} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const scratchRoot = join(repositoryRoot, ".llm");
mkdirSync(scratchRoot, {recursive: true});
const installRoot = mkdtempSync(join(scratchRoot, "skills-install-smoke-"));

try {
	const result = spawnSync(
		"npx",
		[
			"-y",
			"skills",
			"add",
			repositoryRoot,
			"--skill",
			"yepnope",
			"--skill",
			"yepnope-setup",
			"--agent",
			"claude-code",
			"--agent",
			"codex",
			"--copy",
			"--yes",
		],
		{
			cwd: installRoot,
			encoding: "utf8",
			env: {...process.env, NO_COLOR: "1"},
			timeout: 120_000,
		},
	);

	assert.equal(result.status, 0, `skills installer failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

	const skillNames = ["yepnope", "yepnope-setup"] as const;
	const agentRoots = [".agents", ".claude"] as const;
	for (const skillName of skillNames) {
		const canonicalSkill = readFileSync(
			join(repositoryRoot, "plugins", "yepnope", "skills", skillName, "SKILL.md"),
			"utf8",
		);
		for (const agentRoot of agentRoots) {
			const installedSkill = readFileSync(join(installRoot, agentRoot, "skills", skillName, "SKILL.md"), "utf8");
			assert.equal(installedSkill, canonicalSkill);
		}
	}

	assert.equal(existsSync(join(installRoot, ".claude", "settings.json")), false);
	assert.equal(existsSync(join(installRoot, ".codex", "config.toml")), false);
	console.log("Installed both YepNope skills for Claude Code and Codex without client settings.");
} finally {
	const resolvedScratchRoot = resolve(scratchRoot);
	const resolvedInstallRoot = resolve(installRoot);
	assert.equal(resolvedInstallRoot.startsWith(`${resolvedScratchRoot}${sep}`), true);
	rmSync(resolvedInstallRoot, {recursive: true});
}
