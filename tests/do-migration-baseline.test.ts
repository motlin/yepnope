import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";

// 🔒 The Durable Object baseline is immutable: `initialize()` asserts the bundle holds exactly one
// migration, stamps the hash below into `__drizzle_migrations`, and refuses to serve an object whose
// ledger says anything else. A live object has already applied it, so editing the baseline orphans
// every object that exists — it can only change alongside a full wipe. These assertions exist so
// that rule fails in `just verify` rather than in production, and so the hand-maintained `hashes`
// entry, which drizzle-kit does not generate, can never drift from the file it describes.

const baselineTag = "001_initial";
const baselineSource = readFileSync(new URL(`../worker/migrations/do/${baselineTag}.sql`, import.meta.url), "utf8");
const bundleSource = readFileSync(new URL("../worker/migrations/do/migrations.js", import.meta.url), "utf8");
const journal = JSON.parse(
	readFileSync(new URL("../worker/migrations/do/meta/_journal.json", import.meta.url), "utf8"),
) as {entries: Array<{idx: number; tag: string}>};

function rows(database: DatabaseSync, statement: string): Array<Record<string, unknown>> {
	return database
		.prepare(statement)
		.all()
		.map((row) => ({...row}));
}

describe("Durable Object migration baseline", () => {
	it("is a single migration whose recorded hash matches the file the object applies", () => {
		expect({
			bundledHash: /m0000"?\s*:\s*"([0-9a-f]{64})"/.exec(bundleSource)?.[1],
			entries: journal.entries.map((entry) => entry.tag),
		}).toStrictEqual({
			bundledHash: createHash("sha256").update(baselineSource).digest("hex"),
			entries: [baselineTag],
		});
	});

	it("creates the per-account tables and none of the ones the merge flow left behind", () => {
		const database = new DatabaseSync(":memory:");
		database.exec("PRAGMA foreign_keys = ON");
		database.exec("BEGIN");
		for (const statement of baselineSource.split("--> statement-breakpoint")) {
			if (statement.trim() !== "") {
				database.exec(statement);
			}
		}
		database.exec("COMMIT");

		expect({
			// 🪦 `identity_merges` and `identity_merge_lock` backed the legacy claim flow and are gone.
			// The four context columns are the card's chips, so all four stay.
			batchColumns: rows(database, "PRAGMA table_info(batches)").map((column) => column["name"]),
			tables: rows(database, "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").map((row) =>
				String(row["name"]),
			),
		}).toStrictEqual({
			batchColumns: [
				"id",
				"project",
				"repo",
				"branch",
				"worktree",
				"directory",
				"created_at",
				"last_heartbeat_at",
			],
			tables: ["answers", "batches", "devices", "question_activity", "questions", "state"],
		});

		database.close();
	});
});
