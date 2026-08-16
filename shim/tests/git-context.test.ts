import {execFile} from "node:child_process";
import {mkdtemp, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
import {deriveGitContext, normalizeRemoteUrl} from "../git-context";

const run = promisify(execFile);

describe("normalizeRemoteUrl", () => {
	it("normalizes scp-style ssh remotes", () => {
		expect(normalizeRemoteUrl("git@github.com:twosigma/fabric.git")).toBe("github.com/twosigma/fabric");
	});

	it("normalizes https remotes", () => {
		expect(normalizeRemoteUrl("https://github.com/twosigma/fabric.git")).toBe("github.com/twosigma/fabric");
	});

	it("leaves remotes without a .git suffix intact", () => {
		expect(normalizeRemoteUrl("https://github.com/twosigma/fabric")).toBe("github.com/twosigma/fabric");
	});

	it("normalizes ssh scheme remotes", () => {
		expect(normalizeRemoteUrl("ssh://git@github.com/twosigma/fabric.git")).toBe("github.com/twosigma/fabric");
	});
});

describe("deriveGitContext", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "yepnope-shim-"));
	});

	afterEach(async () => {
		await rm(directory, {recursive: true, force: true});
	});

	it("derives repo, branch, and worktree from a git checkout", async () => {
		await run("git", ["init", "-b", "main"], {cwd: directory});
		await run("git", ["remote", "add", "origin", "git@github.com:acme/rocket.git"], {cwd: directory});
		const context = await deriveGitContext(directory);
		expect(context).toEqual({
			repo: "github.com/acme/rocket",
			branch: "main",
			worktree: await realpath(directory),
			directory,
		});
	});

	it("returns nulls outside a git checkout", async () => {
		const context = await deriveGitContext(directory);
		expect(context).toEqual({repo: null, branch: null, worktree: null, directory});
	});
});
