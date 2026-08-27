import {describe, expect, it, vi} from "vitest";
import {planRelease, runRelease, type CommandResult, type ReleaseDependencies} from "../scripts/release";

const NOW = new Date("2026-08-20T12:00:00.000Z");
const TAG = "v2026.08.20-abc1234";
const VERSION_ID = "1d9f8b6a-4c2e-4f77-9b32-2f6c9c9c7a11";

const PENDING_ANNOTATION = `YepNope release ${TAG}\n\nDeploying commit abc1234 to yepnope.app.\n`;
const RELEASED_ANNOTATION =
	`YepNope release ${TAG}\n\nDeployed commit abc1234 to yepnope.app.\n` + `cloudflare_version_id: ${VERSION_ID}\n`;

function ok(output = ""): CommandResult {
	return {code: 0, output};
}

const CLEAN_TREE = ok();
const UPSTREAM = ok("origin/main\n");
const FETCHED = ok();
const IN_SYNC = ok("0\t0\n");
const HEAD_COMMIT = ok("abc1234\n");
const UNUSED_TAG = ok();
const VERIFIED = ok("All pre-commit checks passed!\n");
const BUILT = ok("built in 1.21s\n");
const TAGGED = ok();
const DEPLOYED = ok(`Uploaded yepnope (4.21 sec)\nDeployed yepnope triggers\nCurrent Version ID: ${VERSION_ID}\n`);
const PUSHED = ok("");

const PLAN_CALLS = [
	["git", ["status", "--porcelain"]],
	["git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]],
	["git", ["fetch", "--quiet", "origin"]],
	["git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]],
	["git", ["rev-parse", "--short", "HEAD"]],
	["git", ["tag", "--list", TAG]],
];

// A production deployment carrying every name the Worker reads. `tests/preflight.test.ts` covers
// what each missing one does; these only have to get the release past the gate.
const CONFIGURED_SECRETS = ok(
	JSON.stringify(
		["BETTER_AUTH_SECRET", "TURNSTILE_SECRET_KEY", "TURNSTILE_SITE_KEY", "VAPID_PRIVATE_JWK"].map((name) => ({
			name,
			type: "secret_text",
		})),
	),
);
const CONFIGURED_BINDINGS = ok(
	[
		"Your Worker has access to the following bindings:",
		"env.USER_DO (UserDurableObject)",
		"env.EMAIL (unrestricted - senders: accounts@yepnope.app)",
		"env.DB (yepnope)",
		'env.AUTH_EMAIL_FROM ("accounts@yepnope.app")',
		'env.BETTER_AUTH_URL ("https://yepnope.app")',
		'env.VAPID_SUBJECT ("mailto:push@yepnope.app")',
	].join("\n"),
);
const STAGING_ORIGIN = "https://yepnope-staging.example.workers.dev";
const STAGING_BINDINGS = ok(`env.BETTER_AUTH_URL ("${STAGING_ORIGIN}")`);
const STAGING_CONFIGURATION = `{\n\t"vars": {\n\t\t"BETTER_AUTH_URL": "${STAGING_ORIGIN}"\n\t}\n}\n`;
const PREFLIGHT = [CONFIGURED_SECRETS, CONFIGURED_BINDINGS, STAGING_BINDINGS];
const PREFLIGHT_CALLS = [
	["vp", ["exec", "wrangler", "secret", "list", "--format", "json"]],
	["vp", ["exec", "wrangler", "deploy", "--dry-run"]],
	["vp", ["exec", "wrangler", "deploy", "--dry-run", "--config", "wrangler.staging.jsonc"]],
];

// 🎭 The rehearsal: this tree onto staging, then the one check that proves a question still reaches
// a deck and comes back as an answer on a real deployment.
const STAGING_DEPLOYED = ok("Uploaded yepnope-staging (3.10 sec)\nCurrent Version ID: 8f0b1a52-...\n");
const CORE_LOOP_PROVEN = ok("1 passed (48.2s)\n");
const REHEARSAL = [STAGING_DEPLOYED, CORE_LOOP_PROVEN];
const REHEARSAL_CALLS = [
	["vp", ["build"]],
	["vp", ["exec", "wrangler", "deploy", "--config", "wrangler.staging.jsonc"]],
	["just", ["check-deployment", STAGING_ORIGIN]],
];

function releaseRunner(results: CommandResult[]) {
	const run = vi.fn<ReleaseDependencies["run"]>();
	for (const result of results) {
		run.mockResolvedValueOnce(result);
	}
	return run;
}

function dependencies(run: ReturnType<typeof releaseRunner>): ReleaseDependencies {
	return {
		now: () => NOW,
		readTextFile: vi.fn<ReleaseDependencies["readTextFile"]>().mockResolvedValue(STAGING_CONFIGURATION),
		run,
	};
}

describe("just release", () => {
	it("plans a release from the date and the commit without touching the repository", async () => {
		const run = releaseRunner([CLEAN_TREE, UPSTREAM, FETCHED, IN_SYNC, HEAD_COMMIT, UNUSED_TAG]);

		expect(await planRelease(dependencies(run))).toStrictEqual({
			commit: "abc1234",
			remote: "origin",
			tag: TAG,
		});
		expect(run.mock.calls).toStrictEqual(PLAN_CALLS);
	});

	it("verifies, tags, deploys, records the version id, and pushes the tag last", async () => {
		const run = releaseRunner([
			CLEAN_TREE,
			UPSTREAM,
			FETCHED,
			IN_SYNC,
			HEAD_COMMIT,
			UNUSED_TAG,
			...PREFLIGHT,
			VERIFIED,
			BUILT,
			...REHEARSAL,
			TAGGED,
			DEPLOYED,
			TAGGED,
			PUSHED,
		]);

		expect(await runRelease(dependencies(run))).toStrictEqual({
			commit: "abc1234",
			remote: "origin",
			tag: TAG,
			version_id: VERSION_ID,
		});
		expect(run.mock.calls).toStrictEqual([
			...PLAN_CALLS,
			...PREFLIGHT_CALLS,
			["just", ["verify"]],
			...REHEARSAL_CALLS,
			["git", ["tag", "--annotate", TAG, "--message", PENDING_ANNOTATION]],
			["vp", ["run", "deploy"]],
			["git", ["tag", "--annotate", "--force", TAG, "--message", RELEASED_ANNOTATION]],
			["git", ["push", "origin", `refs/tags/${TAG}`]],
		]);
	});

	it("refuses to release a dirty working tree before running anything else", async () => {
		const run = releaseRunner([ok(" M worker/index.ts\n")]);

		await expect(runRelease(dependencies(run))).rejects.toThrow(
			"the working tree has uncommitted changes; commit or stash them before releasing",
		);
		expect(run.mock.calls).toStrictEqual([["git", ["status", "--porcelain"]]]);
	});

	it("refuses to release a branch that has no upstream to compare against", async () => {
		const run = releaseRunner([CLEAN_TREE, {code: 128, output: "fatal: no upstream configured\n"}]);

		await expect(runRelease(dependencies(run))).rejects.toThrow(
			"the current branch has no upstream branch; push it before releasing",
		);
	});

	it("refuses to release a branch that tracks another local branch", async () => {
		const run = releaseRunner([CLEAN_TREE, ok("main\n")]);

		await expect(runRelease(dependencies(run))).rejects.toThrow(
			"main is a local branch, so there is no remote to push a release tag to",
		);
	});

	it("refuses to trust the behind check when the fetch that refreshes it fails", async () => {
		const run = releaseRunner([CLEAN_TREE, UPSTREAM, {code: 128, output: "fatal: unable to access origin\n"}]);

		await expect(runRelease(dependencies(run))).rejects.toThrow(
			"`git fetch --quiet origin` failed with exit code 128",
		);
	});

	it("refuses to release a branch that is behind its upstream", async () => {
		const run = releaseRunner([CLEAN_TREE, UPSTREAM, FETCHED, ok("1\t3\n")]);

		await expect(runRelease(dependencies(run))).rejects.toThrow(
			"the current branch is 3 commits behind origin/main; rebase before releasing",
		);
	});

	it("refuses to release a commit that already carries its release tag", async () => {
		const run = releaseRunner([CLEAN_TREE, UPSTREAM, FETCHED, IN_SYNC, HEAD_COMMIT, ok(`${TAG}\n`)]);

		await expect(runRelease(dependencies(run))).rejects.toThrow(
			`${TAG} already exists, so this commit is already released`,
		);
	});

	it("stops at a failed verify, before any tag exists", async () => {
		const run = releaseRunner([
			CLEAN_TREE,
			UPSTREAM,
			FETCHED,
			IN_SYNC,
			HEAD_COMMIT,
			UNUSED_TAG,
			...PREFLIGHT,
			{code: 1, output: "2 tests failed\n"},
		]);

		await expect(runRelease(dependencies(run))).rejects.toThrow("`just verify` failed with exit code 1");
		expect(run.mock.calls).toStrictEqual([...PLAN_CALLS, ...PREFLIGHT_CALLS, ["just", ["verify"]]]);
	});

	it("stops before staging when the post-verify artifact cannot be built", async () => {
		const run = releaseRunner([
			CLEAN_TREE,
			UPSTREAM,
			FETCHED,
			IN_SYNC,
			HEAD_COMMIT,
			UNUSED_TAG,
			...PREFLIGHT,
			VERIFIED,
			{code: 1, output: "vite build failed\n"},
		]);

		await expect(runRelease(dependencies(run))).rejects.toThrow(
			"building the staging artifact failed with exit code 1, so nothing was deployed",
		);
		expect(run.mock.calls).toStrictEqual([
			...PLAN_CALLS,
			...PREFLIGHT_CALLS,
			["just", ["verify"]],
			REHEARSAL_CALLS[0],
		]);
	});

	it("refuses an unconfigured deployment before spending a verify or cutting a tag", async () => {
		const run = releaseRunner([
			CLEAN_TREE,
			UPSTREAM,
			FETCHED,
			IN_SYNC,
			HEAD_COMMIT,
			UNUSED_TAG,
			ok(JSON.stringify([{name: "BETTER_AUTH_SECRET", type: "secret_text"}])),
			CONFIGURED_BINDINGS,
		]);

		await expect(runRelease(dependencies(run))).rejects.toThrow(
			"refusing to release: the yepnope.app Worker is missing configuration it reads at runtime",
		);
		expect(run.mock.calls).toStrictEqual([...PLAN_CALLS, ...PREFLIGHT_CALLS.slice(0, 2)]);
	});

	it("stops before tagging when this tree cannot be deployed to staging", async () => {
		const run = releaseRunner([
			CLEAN_TREE,
			UPSTREAM,
			FETCHED,
			IN_SYNC,
			HEAD_COMMIT,
			UNUSED_TAG,
			...PREFLIGHT,
			VERIFIED,
			BUILT,
			{code: 1, output: "Authentication error [code: 10000]\n"},
		]);

		await expect(runRelease(dependencies(run))).rejects.toThrow(
			`deploying this tree to ${STAGING_ORIGIN} failed with exit code 1, so the core loop could not be ` +
				"proven; nothing was tagged or deployed",
		);
		expect(run.mock.calls).toStrictEqual([
			...PLAN_CALLS,
			...PREFLIGHT_CALLS,
			["just", ["verify"]],
			...REHEARSAL_CALLS.slice(0, 2),
		]);
	});

	it("stops before tagging when the core loop no longer works on a real deployment", async () => {
		const run = releaseRunner([
			CLEAN_TREE,
			UPSTREAM,
			FETCHED,
			IN_SYNC,
			HEAD_COMMIT,
			UNUSED_TAG,
			...PREFLIGHT,
			VERIFIED,
			BUILT,
			STAGING_DEPLOYED,
			{code: 1, output: "1 failed\n  a deployed YepNope answers an authorized MCP client's question\n"},
		]);

		await expect(runRelease(dependencies(run))).rejects.toThrow(
			`the core loop failed on ${STAGING_ORIGIN} with exit code 1, so this tree is not releasable; ` +
				"nothing was tagged or deployed",
		);
		expect(run.mock.calls).toStrictEqual([
			...PLAN_CALLS,
			...PREFLIGHT_CALLS,
			["just", ["verify"]],
			...REHEARSAL_CALLS,
		]);
	});

	it("deletes the local tag and never pushes when the deploy fails", async () => {
		const run = releaseRunner([
			CLEAN_TREE,
			UPSTREAM,
			FETCHED,
			IN_SYNC,
			HEAD_COMMIT,
			UNUSED_TAG,
			...PREFLIGHT,
			VERIFIED,
			BUILT,
			...REHEARSAL,
			TAGGED,
			{code: 1, output: "Authentication error [code: 10000]\n"},
			ok(`Deleted tag '${TAG}'\n`),
		]);

		await expect(runRelease(dependencies(run))).rejects.toThrow(
			`\`vp run deploy\` failed with exit code 1; deleted the unpushed tag ${TAG}`,
		);
		expect(run.mock.calls.at(-1)).toStrictEqual(["git", ["tag", "--delete", TAG]]);
	});

	it("deletes the local tag when the deploy reports no version id to record", async () => {
		const run = releaseRunner([
			CLEAN_TREE,
			UPSTREAM,
			FETCHED,
			IN_SYNC,
			HEAD_COMMIT,
			UNUSED_TAG,
			...PREFLIGHT,
			VERIFIED,
			BUILT,
			...REHEARSAL,
			TAGGED,
			ok("Uploaded yepnope (4.21 sec)\n"),
			ok(`Deleted tag '${TAG}'\n`),
		]);

		await expect(runRelease(dependencies(run))).rejects.toThrow(
			`the deploy printed no Cloudflare Version ID, so ${TAG} cannot name a deployment; ` +
				"deleted the unpushed tag",
		);
		expect(run.mock.calls.at(-1)).toStrictEqual(["git", ["tag", "--delete", TAG]]);
	});

	it("fails loudly with the deployed version id when pushing the tag fails", async () => {
		const run = releaseRunner([
			CLEAN_TREE,
			UPSTREAM,
			FETCHED,
			IN_SYNC,
			HEAD_COMMIT,
			UNUSED_TAG,
			...PREFLIGHT,
			VERIFIED,
			BUILT,
			...REHEARSAL,
			TAGGED,
			DEPLOYED,
			TAGGED,
			{code: 1, output: "! [remote rejected]\n"},
		]);

		await expect(runRelease(dependencies(run))).rejects.toThrow(
			`deployed Cloudflare version ${VERSION_ID}, but pushing ${TAG} failed with exit code 1; ` +
				`push it with \`git push origin refs/tags/${TAG}\``,
		);
	});
});
