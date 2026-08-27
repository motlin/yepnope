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

function migratedDatabase(): DatabaseSync {
	const database = new DatabaseSync(":memory:");
	database.exec("PRAGMA foreign_keys = ON");
	for (const migration of migrations) {
		applyMigration(database, migration.source);
	}
	return database;
}

describe("D1 migrations", () => {
	it("creates every table the schema declares and nothing the service retired", () => {
		const database = migratedDatabase();

		expect({
			foreignKeyViolations: rows(database, "PRAGMA foreign_key_check"),
			tables: rows(database, "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").map((row) =>
				String(row["name"]),
			),
		}).toStrictEqual({
			foreignKeyViolations: [],
			// 🪦 `legacy_identity_claims`, `machine_tokens`, and `pairing_codes` are absent by never
			// being created. The device grant replaced them; nothing reads them and nothing may.
			tables: [
				"account",
				"device_code",
				"durable_object_cleanup_jobs",
				"identity_lifecycles",
				"jwks",
				"mcp_client_use",
				"oauth_access_token",
				"oauth_client",
				"oauth_client_assertion",
				"oauth_client_resource",
				"oauth_consent",
				"oauth_refresh_token",
				"oauth_resource",
				"passkey",
				"session",
				"user",
				"verification",
			],
		});

		database.close();
	});

	it("holds an account, its credentials, and its session", () => {
		const database = migratedDatabase();

		const timestamp = Date.parse("2000-01-01T00:00:00.000Z");
		database
			.prepare("INSERT INTO user (id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
			.run("alice", "alice@example.com", 1, timestamp, timestamp);
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
				"INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run("alice-session", timestamp + 60_000, "fake-session-token", timestamp, timestamp, "alice");

		expect({
			account: rows(database, "SELECT id, user_id, password FROM account"),
			deviceCodeColumns: rows(database, "PRAGMA table_info(device_code)").map((column) => column["name"]),
			foreignKeyViolations: rows(database, "PRAGMA foreign_key_check"),
			sessions: rows(database, "SELECT id, user_id, token FROM session"),
			// Better Auth 1.7 requires the nullable compatibility column; YepNope never writes it.
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
			sessions: [{id: "alice-session", token: "fake-session-token", user_id: "alice"}],
			users: [{email: "alice@example.com", id: "alice", name: null}],
		});

		database.close();
	});

	it("deletes an account's credentials, sessions, and grants with the account row", () => {
		const database = migratedDatabase();

		const timestamp = Date.parse("2000-01-01T00:00:00.000Z");
		database
			.prepare("INSERT INTO user (id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
			.run("alice", "alice@example.com", 1, timestamp, timestamp);
		database
			.prepare(
				"INSERT INTO account " +
					"(id, issuer, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				"alice-account",
				"https://example.com",
				"alice@example.com",
				"credential",
				"alice",
				timestamp,
				timestamp,
			);
		database
			.prepare(
				"INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run("alice-session", timestamp + 60_000, "fake-session-token", timestamp, timestamp, "alice");
		database
			.prepare("INSERT INTO oauth_client (id, client_id, user_id, redirect_uris) VALUES (?, ?, ?, ?)")
			.run("alice-client-row", "alice-client", "alice", "[]");
		database
			.prepare("INSERT INTO mcp_client_use (user_id, client_id, last_used_at) VALUES (?, ?, ?)")
			.run("alice", "alice-client", timestamp);
		database
			.prepare(
				"INSERT INTO oauth_consent " +
					"(id, client_id, user_id, scopes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run("alice-consent", "alice-client", "alice", "[]", timestamp, timestamp);

		database.prepare("DELETE FROM user WHERE id = ?").run("alice");

		expect({
			accounts: rows(database, "SELECT id FROM account"),
			clientUses: rows(database, "SELECT user_id FROM mcp_client_use"),
			clients: rows(database, "SELECT client_id FROM oauth_client"),
			consents: rows(database, "SELECT id FROM oauth_consent"),
			foreignKeyViolations: rows(database, "PRAGMA foreign_key_check"),
			sessions: rows(database, "SELECT id FROM session"),
		}).toStrictEqual({
			accounts: [],
			clientUses: [],
			clients: [],
			consents: [],
			foreignKeyViolations: [],
			sessions: [],
		});

		database.close();
	});

	it("removes retained inactive MCP grants while preserving active grants and client registrations", () => {
		const initial = migrations.find(({tag}) => tag === "001_initial");
		const cleanup = migrations.find(({tag}) => tag === "002_remove_inactive_mcp_authorizations");
		if (initial === undefined || cleanup === undefined) {
			throw new Error("missing inactive MCP authorization cleanup migration");
		}
		const database = new DatabaseSync(":memory:");
		database.exec("PRAGMA foreign_keys = ON");
		applyMigration(database, initial.source);
		const createdAt = Date.parse("2000-01-01T00:00:00.000Z");
		const expiresAt = Date.parse("2099-01-01T00:00:00.000Z");
		const scopes = JSON.stringify(["openid", "yepnope:questions"]);
		const resources = JSON.stringify(["https://yepnope.app/mcp"]);
		database
			.prepare("INSERT INTO user (id, email, email_verified, created_at, updated_at) VALUES (?, ?, 1, ?, ?)")
			.run("alice", "alice@example.com", createdAt, createdAt);
		for (const [clientId, name] of [
			["active-client", "Active Codex"],
			["revoked-client", "Revoked Codex"],
		] as const) {
			database
				.prepare(
					"INSERT INTO oauth_client (id, client_id, user_id, created_at, updated_at, name, redirect_uris) " +
						"VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(`${clientId}-row`, clientId, "alice", createdAt, createdAt, name, "[]");
			database
				.prepare(
					"INSERT INTO oauth_consent " +
						"(id, client_id, user_id, resources, scopes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(`${clientId}-consent`, clientId, "alice", resources, scopes, createdAt, createdAt);
			database
				.prepare(
					"INSERT INTO oauth_refresh_token " +
						"(id, token, client_id, user_id, resources, expires_at, created_at, revoked, scopes) " +
						"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					`${clientId}-refresh`,
					`${clientId}-refresh-token`,
					clientId,
					"alice",
					resources,
					expiresAt,
					createdAt,
					clientId === "revoked-client" ? createdAt : null,
					scopes,
				);
			database
				.prepare("INSERT INTO mcp_client_use (user_id, client_id, last_used_at) VALUES (?, ?, ?)")
				.run("alice", clientId, createdAt);
		}
		database
			.prepare(
				"INSERT INTO oauth_access_token " +
					"(id, token, client_id, user_id, refresh_id, resources, expires_at, created_at, revoked, scopes) " +
					"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				"revoked-client-access",
				"revoked-client-access-token",
				"revoked-client",
				"alice",
				"revoked-client-refresh",
				resources,
				expiresAt,
				createdAt,
				createdAt,
				scopes,
			);
		database
			.prepare("INSERT INTO verification (id, identifier, value, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)")
			.run(
				"revoked-client-code",
				"revoked-client-code",
				JSON.stringify({
					type: "authorization_code",
					userId: "alice",
					query: {client_id: "revoked-client"},
				}),
				expiresAt,
				createdAt,
			);

		applyMigration(database, cleanup.source);

		expect({
			accessTokens: rows(database, "SELECT client_id FROM oauth_access_token ORDER BY client_id"),
			clientUses: rows(database, "SELECT client_id FROM mcp_client_use ORDER BY client_id"),
			clients: rows(database, "SELECT client_id FROM oauth_client ORDER BY client_id"),
			consents: rows(database, "SELECT client_id FROM oauth_consent ORDER BY client_id"),
			foreignKeyViolations: rows(database, "PRAGMA foreign_key_check"),
			refreshTokens: rows(database, "SELECT client_id FROM oauth_refresh_token ORDER BY client_id"),
			verifications: rows(database, "SELECT id FROM verification ORDER BY id"),
		}).toStrictEqual({
			accessTokens: [],
			clientUses: [{client_id: "active-client"}],
			clients: [{client_id: "active-client"}, {client_id: "revoked-client"}],
			consents: [{client_id: "active-client"}],
			foreignKeyViolations: [],
			refreshTokens: [{client_id: "active-client"}],
			verifications: [],
		});

		database.close();
	});
});
