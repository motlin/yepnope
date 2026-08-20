import {spawn} from "node:child_process";
import {pathToFileURL} from "node:url";
import {z} from "zod";
// Node runs this file directly, so the relative import carries the extension TypeScript allows.
import {
	ABANDONED_OAUTH_CLIENT_COUNT_SQL,
	ABANDONED_OAUTH_CLIENT_GRACE_MILLISECONDS,
	RECLAIMABLE_OAUTH_CLIENT_RESOURCE_COUNT_SQL,
	withInlineTimestamps,
} from "../worker/db/oauth-client-reclamation.ts";

/**
 * 🔍 The dry run for abandoned OAuth client reclamation.
 *
 * Reclamation itself belongs to the Worker's nightly cron, which is the only thing that deletes.
 * This script answers the question that has to be answered before the first destructive run — how
 * many rows the predicate would take — and it answers it with the very SQL the cron deletes by, so
 * the two cannot drift. It issues nothing but `SELECT count(*)`, which is checked before each
 * invocation, so it cannot delete even by accident, and it reports counts only: no client id,
 * redirect URI, secret, or user identifier is read, let alone printed.
 */

const DATABASE = "yepnope";
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

const queryResultSchema = z.array(
	z.object({success: z.literal(true), results: z.array(z.object({value: z.number().int().nonnegative()}))}),
);

export interface CommandResult {
	code: number;
	output: string;
}

export interface ReclamationDryRunDependencies {
	now: () => number;
	run: (command: string, commandArguments: readonly string[]) => Promise<CommandResult>;
}

export interface ReclamationDryRunReport {
	abandoned_oauth_clients: number;
	database: string;
	grace_days: number;
	mode: "dry-run";
	reclaimable_oauth_client_resources: number;
	target: "remote";
}

export function assertReadOnly(sql: string): void {
	if (!sql.startsWith("SELECT count(*) AS value FROM ")) {
		throw new Error(`refusing to run a statement that is not a count: ${sql}`);
	}
}

async function count(dependencies: ReclamationDryRunDependencies, sql: string, now: number): Promise<number> {
	assertReadOnly(sql);
	const result = await dependencies.run("wrangler", [
		"d1",
		"execute",
		DATABASE,
		"--remote",
		"--json",
		"--command",
		withInlineTimestamps(sql, now),
	]);
	if (result.code !== 0) {
		throw new Error(`\`wrangler d1 execute ${DATABASE} --remote\` failed with exit code ${result.code}`);
	}
	for (const query of queryResultSchema.parse(JSON.parse(result.output) as unknown)) {
		for (const row of query.results) {
			return row.value;
		}
	}
	throw new Error(`\`wrangler d1 execute ${DATABASE} --remote\` returned no count`);
}

export async function runReclamationDryRun(
	dependencies: ReclamationDryRunDependencies,
): Promise<ReclamationDryRunReport> {
	const now = dependencies.now();
	return {
		abandoned_oauth_clients: await count(dependencies, ABANDONED_OAUTH_CLIENT_COUNT_SQL, now),
		database: DATABASE,
		grace_days: ABANDONED_OAUTH_CLIENT_GRACE_MILLISECONDS / DAY_MILLISECONDS,
		mode: "dry-run",
		reclaimable_oauth_client_resources: await count(dependencies, RECLAIMABLE_OAUTH_CLIENT_RESOURCE_COUNT_SQL, now),
		target: "remote",
	};
}

async function spawnCommand(command: string, commandArguments: readonly string[]): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...commandArguments], {
			env: {...process.env, NO_COLOR: "1"},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			output += chunk;
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			process.stderr.write(chunk);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({code: code ?? 1, output});
		});
	});
}

const entryPath = process.argv.at(1);
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
	console.log(JSON.stringify(await runReclamationDryRun({now: () => Date.now(), run: spawnCommand}), null, 2));
}
