import {spawn} from "node:child_process";
import {pathToFileURL} from "node:url";
// Node runs this file directly, so the relative import carries the extension TypeScript allows.
import {preflightDeployment, PRODUCTION_HOSTNAME, STAGING_CONFIG, type CommandResult} from "./preflight.ts";

/**
 * 🚀 One-command production release: guard, preflight, verify, rehearse on staging, tag, deploy, push.
 *
 * A release is a git tag that names a Cloudflare deployment. The tag is cut before the deploy so the
 * deployed tree is exactly the tagged tree, and it is pushed only after Wrangler reports a Version
 * ID, which the annotation records. Every other outcome fails loudly: a dirty tree, a branch behind
 * its upstream, an already-released commit, a deployment missing a secret or binding the Worker
 * reads, a failed verify, a core loop that no longer works on a real deployment, or a deploy that
 * never named a version all stop the release, and a deploy that fails after tagging takes its
 * unpushed tag down with it.
 *
 * `package.json` stays at 0.0.0 — nothing installs YepNope from a registry — so the release version
 * is the UTC date plus the short commit, which is unique per released commit and sorts by date.
 */

const VERSION_ID_PATTERN = /Current Version ID:\s*([0-9a-f-]{36})/i;

export type {CommandResult};

export interface ReleaseDependencies {
	now: () => Date;
	run: (command: string, commandArguments: readonly string[]) => Promise<CommandResult>;
}

export interface ReleasePlan {
	commit: string;
	remote: string;
	tag: string;
}

export interface ReleaseReport extends ReleasePlan {
	version_id: string;
}

function releaseTag(now: Date, commit: string): string {
	return `v${now.toISOString().slice(0, 10).replaceAll("-", ".")}-${commit}`;
}

function pendingAnnotation(plan: ReleasePlan): string {
	return `YepNope release ${plan.tag}\n\nDeploying commit ${plan.commit} to ${PRODUCTION_HOSTNAME}.\n`;
}

function releasedAnnotation(plan: ReleasePlan, versionId: string): string {
	return (
		`YepNope release ${plan.tag}\n\nDeployed commit ${plan.commit} to ${PRODUCTION_HOSTNAME}.\n` +
		`cloudflare_version_id: ${versionId}\n`
	);
}

async function git(dependencies: ReleaseDependencies, commandArguments: readonly string[]): Promise<string> {
	const result = await dependencies.run("git", commandArguments);
	if (result.code !== 0) {
		throw new Error(`\`git ${commandArguments.join(" ")}\` failed with exit code ${result.code}`);
	}
	return result.output.trim();
}

export async function planRelease(dependencies: ReleaseDependencies): Promise<ReleasePlan> {
	const status = await git(dependencies, ["status", "--porcelain"]);
	if (status !== "") {
		throw new Error("the working tree has uncommitted changes; commit or stash them before releasing");
	}

	const upstream = await dependencies.run("git", [
		"rev-parse",
		"--abbrev-ref",
		"--symbolic-full-name",
		"@{upstream}",
	]);
	if (upstream.code !== 0) {
		throw new Error("the current branch has no upstream branch; push it before releasing");
	}
	const upstreamBranch = upstream.output.trim();
	const separator = upstreamBranch.indexOf("/");
	if (separator === -1) {
		throw new Error(`${upstreamBranch} is a local branch, so there is no remote to push a release tag to`);
	}
	const remote = upstreamBranch.slice(0, separator);

	// 🛰️ Fetch first, and loudly: a stale remote-tracking ref would let the behind check pass a branch
	// that upstream has already moved past.
	await git(dependencies, ["fetch", "--quiet", remote]);

	const divergence = await git(dependencies, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
	const behind = Number(divergence.split(/\s+/)[1]);
	if (behind > 0) {
		throw new Error(`the current branch is ${behind} commits behind ${upstreamBranch}; rebase before releasing`);
	}

	const commit = await git(dependencies, ["rev-parse", "--short", "HEAD"]);
	const tag = releaseTag(dependencies.now(), commit);

	const existingTag = await git(dependencies, ["tag", "--list", tag]);
	if (existingTag !== "") {
		throw new Error(`${tag} already exists, so this commit is already released`);
	}

	return {commit, remote, tag};
}

export async function runRelease(dependencies: ReleaseDependencies): Promise<ReleaseReport> {
	const {run} = dependencies;
	const plan = await planRelease(dependencies);

	// 🚦 Before the expensive part, and long before anything is tagged: the repository can be
	// perfect and the deployment still be unconfigured. See `scripts/preflight.ts`.
	const deployment = await preflightDeployment(dependencies);

	const verify = await run("just", ["verify"]);
	if (verify.code !== 0) {
		throw new Error(`\`just verify\` failed with exit code ${verify.code}`);
	}

	// 🧱 Browser tests deliberately replace dist/ with version-stamped fixtures. Build again after
	// verification so staging receives this release tree rather than whatever artifact a test left.
	const stagingBuild = await run("vp", ["build"]);
	if (stagingBuild.code !== 0) {
		throw new Error(
			`building the staging artifact failed with exit code ${stagingBuild.code}, so nothing was deployed`,
		);
	}

	// 🎭 Everything above is green in a process on this machine. The product is a question that
	// leaves an agent, crosses Cloudflare, lands on a phone, and comes back as an answer, and no
	// local suite can tell whether that still happens. So this tree is deployed to staging and the
	// core loop is proven there — an OAuth-authorized MCP client, a blocking `ask_yep_nope`, a deck
	// that answers it — before a tag exists or production is touched.
	const stagingDeploy = await run("vp", ["exec", "wrangler", "deploy", "--config", STAGING_CONFIG]);
	if (stagingDeploy.code !== 0) {
		throw new Error(
			`deploying this tree to ${deployment.staging} failed with exit code ${stagingDeploy.code}, ` +
				"so the core loop could not be proven; nothing was tagged or deployed",
		);
	}
	const coreLoop = await run("just", ["check-deployment", deployment.staging]);
	if (coreLoop.code !== 0) {
		throw new Error(
			`the core loop failed on ${deployment.staging} with exit code ${coreLoop.code}, so this tree is not ` +
				"releasable; nothing was tagged or deployed",
		);
	}

	await git(dependencies, ["tag", "--annotate", plan.tag, "--message", pendingAnnotation(plan)]);

	const deploy = await run("vp", ["run", "deploy"]);
	if (deploy.code !== 0) {
		await run("git", ["tag", "--delete", plan.tag]);
		throw new Error(`\`vp run deploy\` failed with exit code ${deploy.code}; deleted the unpushed tag ${plan.tag}`);
	}

	const versionId = VERSION_ID_PATTERN.exec(deploy.output)?.[1];
	if (versionId === undefined) {
		await run("git", ["tag", "--delete", plan.tag]);
		throw new Error(
			`the deploy printed no Cloudflare Version ID, so ${plan.tag} cannot name a deployment; ` +
				"deleted the unpushed tag",
		);
	}

	await git(dependencies, [
		"tag",
		"--annotate",
		"--force",
		plan.tag,
		"--message",
		releasedAnnotation(plan, versionId),
	]);

	const push = await run("git", ["push", plan.remote, `refs/tags/${plan.tag}`]);
	if (push.code !== 0) {
		throw new Error(
			`deployed Cloudflare version ${versionId}, but pushing ${plan.tag} failed with exit code ${push.code}; ` +
				`push it with \`git push ${plan.remote} refs/tags/${plan.tag}\``,
		);
	}

	return {...plan, version_id: versionId};
}

async function spawnCommand(command: string, commandArguments: readonly string[]): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...commandArguments], {
			env: {...process.env, NO_COLOR: "1"},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		for (const stream of [child.stdout, child.stderr]) {
			stream.setEncoding("utf8");
			stream.on("data", (chunk: string) => {
				output += chunk;
				process.stderr.write(chunk);
			});
		}
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({code: code ?? 1, output});
		});
	});
}

async function main(): Promise<void> {
	const dependencies: ReleaseDependencies = {now: () => new Date(), run: spawnCommand};
	if (process.argv.includes("--dry-run")) {
		const plan = await planRelease(dependencies);
		// The preflight reads Cloudflare and changes nothing, so the dry run gets it too: an
		// unconfigured production is exactly what someone runs a dry run to find out about.
		const deployment = await preflightDeployment(dependencies);
		console.log(JSON.stringify({...plan, deployment, status: "planned"}, null, 2));
		return;
	}
	const report = await runRelease(dependencies);
	console.log(JSON.stringify({...report, status: "released"}, null, 2));
}

const entryPath = process.argv.at(1);
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
	await main();
}
