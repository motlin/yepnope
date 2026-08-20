import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";

interface MigrationJournal {
	entries: Array<{idx: number; tag: string}>;
}

const journal = JSON.parse(
	readFileSync(new URL("../worker/migrations/d1/meta/_journal.json", import.meta.url), "utf8"),
) as MigrationJournal;

// Every migration, in the order Wrangler and the Worker test pool apply them, so a new one is
// covered the moment it is added rather than the next time somebody remembers this file.
const migrations = [...journal.entries]
	.sort((left, right) => left.idx - right.idx)
	.map((entry) => ({
		source: readFileSync(new URL(`../worker/migrations/d1/${entry.tag}.sql`, import.meta.url), "utf8"),
		tag: entry.tag,
	}));

function applyMigration(database: DatabaseSync, source: string): void {
	database.exec("BEGIN");
	for (const statement of source.split("--> statement-breakpoint")) {
		if (statement.trim() !== "") {
			database.exec(statement);
		}
	}
	database.exec("COMMIT");
}

function rows(database: DatabaseSync, statement: string): Array<Record<string, unknown>> {
	return database
		.prepare(statement)
		.all()
		.map((row) => ({...row}));
}

function tableNames(database: DatabaseSync): string[] {
	return rows(database, "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").map((row) =>
		String(row["name"]),
	);
}

describe("D1 migrations", () => {
	it("carries an account, its credentials, and its session across every migration", () => {
		const database = new DatabaseSync(":memory:");
		database.exec("PRAGMA foreign_keys = ON");
		const [initial, ...rest] = migrations;
		if (initial === undefined) {
			throw new Error("there is no initial migration to apply");
		}
		applyMigration(database, initial.source);

		const timestamp = Date.parse("2000-01-01T00:00:00.000Z");
		database
			.prepare(
				"INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run("alice", "Alice", "alice@example.com", 1, timestamp, timestamp);
		database
			.prepare(
				"INSERT INTO account " +
					"(id, issuer, account_id, provider_id, user_id, password, created_at, updated_at) " +
					"VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				"alice-account",
				"https://example.com",
				"alice@example.com",
				"credential",
				"alice",
				"not-a-real-password-hash",
				timestamp,
				timestamp,
			);
		// 🪦 The credentials this service used to issue. They are seeded so the migration that drops
		// them is proven to tolerate populated tables, not just empty ones.
		database
			.prepare(
				"INSERT INTO legacy_identity_claims " +
					"(token_hash, legacy_user_id, user_id, status, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run("fake-legacy-token-hash", "legacy-alice", "alice", "complete", timestamp);
		database
			.prepare(
				"INSERT INTO machine_tokens " +
					"(id, token_hash, user_id, label, credential_type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run("alice-machine", "fake-machine-token-hash", "alice", "Alice CLI", "machine", timestamp);
		database
			.prepare("INSERT INTO pairing_codes (code, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
			.run("ABC234", "alice", timestamp, timestamp + 60_000);
		database
			.prepare(
				"INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run("alice-session", timestamp + 60_000, "fake-session-token", timestamp, timestamp, "alice");

		for (const migration of rest) {
			applyMigration(database, migration.source);
		}

		const finalTables = tableNames(database);
		expect({
			account: rows(database, "SELECT id, user_id, password FROM account"),
			deviceCodeColumns: rows(database, "PRAGMA table_info(device_code)").map((column) => column["name"]),
			foreignKeyViolations: rows(database, "PRAGMA foreign_key_check"),
			retiredTables: ["legacy_identity_claims", "machine_tokens", "pairing_codes"].filter((name) =>
				finalTables.includes(name),
			),
			sessions: rows(database, "SELECT id, user_id, token FROM session"),
			users: rows(database, "SELECT id, name, email FROM user"),
		}).toStrictEqual({
			account: [{id: "alice-account", password: "not-a-real-password-hash", user_id: "alice"}],
			deviceCodeColumns: [
				"id",
				"device_code",
				"user_code",
				"user_id",
				"expires_at",
				"status",
				"last_polled_at",
				"polling_interval",
				"client_id",
				"scope",
				"resources",
				"oauth_client_id",
			],
			foreignKeyViolations: [],
			// 📟 The device grant replaces them outright; nothing reads them and nothing may.
			retiredTables: [],
			sessions: [{id: "alice-session", token: "fake-session-token", user_id: "alice"}],
			users: [{email: "alice@example.com", id: "alice", name: null}],
		});

		database.close();
	});
});
