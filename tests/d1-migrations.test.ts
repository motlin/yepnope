import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";

const initialMigration = readFileSync(new URL("../worker/migrations/d1/001_initial.sql", import.meta.url), "utf8");
const removeAccountNamesMigration = readFileSync(
	new URL("../worker/migrations/d1/002_remove_account_names.sql", import.meta.url),
	"utf8",
);
const oauthMcpProviderMigration = readFileSync(
	new URL("../worker/migrations/d1/003_oauth_mcp_provider.sql", import.meta.url),
	"utf8",
);

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

describe("D1 migrations", () => {
	it("preserves every user-owned credential while making account names nullable", () => {
		const database = new DatabaseSync(":memory:");
		database.exec("PRAGMA foreign_keys = ON");
		applyMigration(database, initialMigration);

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

		applyMigration(database, removeAccountNamesMigration);
		applyMigration(database, oauthMcpProviderMigration);

		expect({
			account: rows(database, "SELECT id, user_id, password FROM account"),
			foreignKeyViolations: rows(database, "PRAGMA foreign_key_check"),
			legacyIdentityClaims: rows(
				database,
				"SELECT token_hash, legacy_user_id, user_id, status FROM legacy_identity_claims",
			),
			machineTokens: rows(database, "SELECT id, token_hash, user_id, label, credential_type FROM machine_tokens"),
			oauthTables: rows(
				database,
				"SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'oauth_%' ORDER BY name",
			),
			pairingCodes: rows(database, "SELECT code, user_id FROM pairing_codes"),
			sessions: rows(database, "SELECT id, user_id, token FROM session"),
			users: rows(database, "SELECT id, name, email FROM user"),
		}).toStrictEqual({
			account: [{id: "alice-account", password: "not-a-real-password-hash", user_id: "alice"}],
			foreignKeyViolations: [],
			legacyIdentityClaims: [
				{
					legacy_user_id: "legacy-alice",
					status: "complete",
					token_hash: "fake-legacy-token-hash",
					user_id: "alice",
				},
			],
			machineTokens: [
				{
					credential_type: "machine",
					id: "alice-machine",
					label: "Alice CLI",
					token_hash: "fake-machine-token-hash",
					user_id: "alice",
				},
			],
			oauthTables: [
				{name: "oauth_access_token"},
				{name: "oauth_client"},
				{name: "oauth_client_assertion"},
				{name: "oauth_client_resource"},
				{name: "oauth_consent"},
				{name: "oauth_refresh_token"},
				{name: "oauth_resource"},
			],
			pairingCodes: [{code: "ABC234", user_id: "alice"}],
			sessions: [{id: "alice-session", token: "fake-session-token", user_id: "alice"}],
			users: [{email: "alice@example.com", id: "alice", name: null}],
		});

		database.close();
	});
});
