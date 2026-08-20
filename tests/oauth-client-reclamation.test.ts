import {describe, expect, it} from "vitest";
import {
	ABANDONED_OAUTH_CLIENT_COUNT_SQL,
	ABANDONED_OAUTH_CLIENT_DELETE_SQL,
	ABANDONED_OAUTH_CLIENT_GRACE_MILLISECONDS,
	withInlineTimestamps,
} from "../worker/db/oauth-client-reclamation";
import {assertReadOnly, runReclamationDryRun, type CommandResult} from "../scripts/oauth-client-reclamation";

const NOW = Date.UTC(2026, 7, 20, 4);
const CUTOFF = NOW - ABANDONED_OAUTH_CLIENT_GRACE_MILLISECONDS;

interface RecordedCommand {
	command: string;
	commandArguments: string[];
}

function wranglerCount(value: number): string {
	return JSON.stringify([{results: [{value}], success: true}]);
}

function recordingDependencies(outputs: readonly string[]) {
	const commands: RecordedCommand[] = [];
	return {
		commands,
		dependencies: {
			now: () => NOW,
			run: async (command: string, commandArguments: readonly string[]): Promise<CommandResult> => {
				commands.push({command, commandArguments: [...commandArguments]});
				return Promise.resolve({code: 0, output: outputs[commands.length - 1] ?? ""});
			},
		},
	};
}

describe("abandoned OAuth client dry run", () => {
	it("reports both counts against the remote database", async () => {
		const {commands, dependencies} = recordingDependencies([wranglerCount(15), wranglerCount(2)]);

		expect(await runReclamationDryRun(dependencies)).toStrictEqual({
			abandoned_oauth_clients: 15,
			database: "yepnope",
			grace_days: 7,
			mode: "dry-run",
			reclaimable_oauth_client_resources: 2,
			target: "remote",
		});
		expect(commands.map(({command, commandArguments}) => [command, ...commandArguments.slice(0, 5)])).toStrictEqual(
			[
				["wrangler", "d1", "execute", "yepnope", "--remote", "--json"],
				["wrangler", "d1", "execute", "yepnope", "--remote", "--json"],
			],
		);
	});

	it("issues nothing but counting statements", async () => {
		const {commands, dependencies} = recordingDependencies([wranglerCount(0), wranglerCount(0)]);

		await runReclamationDryRun(dependencies);

		expect(commands.map(({commandArguments}) => commandArguments.at(-1)?.slice(0, 26))).toStrictEqual([
			"SELECT count(*) AS value F",
			"SELECT count(*) AS value F",
		]);
	});

	it("refuses to hand a deleting statement to Wrangler", () => {
		expect(() => {
			assertReadOnly(ABANDONED_OAUTH_CLIENT_DELETE_SQL);
		}).toThrow(`refusing to run a statement that is not a count: ${ABANDONED_OAUTH_CLIENT_DELETE_SQL}`);
		expect(() => {
			assertReadOnly(ABANDONED_OAUTH_CLIENT_COUNT_SQL);
		}).not.toThrow();
	});

	it("fails loudly when Wrangler fails", async () => {
		await expect(
			runReclamationDryRun({now: () => NOW, run: async () => Promise.resolve({code: 1, output: ""})}),
		).rejects.toThrow("`wrangler d1 execute yepnope --remote` failed with exit code 1");
	});

	it("fails loudly when the query returns no row", async () => {
		await expect(
			runReclamationDryRun({
				now: () => NOW,
				run: async () => Promise.resolve({code: 0, output: JSON.stringify([{results: [], success: true}])}),
			}),
		).rejects.toThrow("`wrangler d1 execute yepnope --remote` returned no count");
	});
});

describe("inline reclamation timestamps", () => {
	it("substitutes the cutoff and the clock reading in order", () => {
		expect(withInlineTimestamps(ABANDONED_OAUTH_CLIENT_COUNT_SQL, NOW)).toStrictEqual(
			ABANDONED_OAUTH_CLIENT_COUNT_SQL.replace("?", String(CUTOFF)).replace("?", String(NOW)),
		);
	});

	it("refuses a statement that does not take exactly the two timestamps", () => {
		expect(() => withInlineTimestamps("SELECT ?", NOW)).toThrow("SELECT ? takes 1 bindings, not 2");
		expect(() => withInlineTimestamps("SELECT ?, ?, ?", NOW)).toThrow("SELECT ?, ?, ? takes more than 2 bindings");
	});
});
