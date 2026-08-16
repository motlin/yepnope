import {execFile} from "node:child_process";
import {promisify} from "node:util";

const run = promisify(execFile);

// 🧭 Card chips (see .llm/decisions.md): repo, branch, and directory are derived here, never
// supplied by the model, so the phone can trust them.
export interface GitContext {
	repo: string | null;
	branch: string | null;
	worktree: string | null;
	directory: string;
}

export function normalizeRemoteUrl(remoteUrl: string): string {
	const trimmed = remoteUrl
		.trim()
		.replace(/\.git$/, "")
		.replace(/\/+$/, "");
	const scpStyle = /^[^@/]+@([^:/]+):(.+)$/.exec(trimmed);
	if (scpStyle !== null) {
		return `${scpStyle[1]}/${scpStyle[2]}`;
	}
	const schemeStyle = /^[a-z+]+:\/\/(?:[^@/]+@)?(.+)$/.exec(trimmed);
	if (schemeStyle?.[1] !== undefined) {
		return schemeStyle[1];
	}
	return trimmed;
}

async function gitOutput(directory: string, args: string[]): Promise<string | null> {
	try {
		const {stdout} = await run("git", args, {cwd: directory});
		const output = stdout.trim();
		return output === "" ? null : output;
	} catch {
		return null;
	}
}

export async function deriveGitContext(directory: string): Promise<GitContext> {
	const [remote, branch, worktree] = await Promise.all([
		gitOutput(directory, ["remote", "get-url", "origin"]),
		gitOutput(directory, ["branch", "--show-current"]),
		gitOutput(directory, ["rev-parse", "--show-toplevel"]),
	]);
	return {
		repo: remote === null ? null : normalizeRemoteUrl(remote),
		branch,
		worktree,
		directory,
	};
}
