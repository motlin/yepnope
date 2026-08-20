import {createExecutionContext, createScheduledController, waitOnExecutionContext} from "cloudflare:test";
import {env} from "cloudflare:workers";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {ABANDONED_OAUTH_CLIENT_GRACE_MILLISECONDS} from "../db/oauth-client-reclamation";
import {
	planAbandonedOAuthClientReclamation,
	reclaimAbandonedOAuthClients,
	type OAuthClientReclamationResult,
} from "../identity-lifecycle";
import worker from "../index";

const NOW = Date.UTC(2026, 7, 20, 4);
const CUTOFF = NOW - ABANDONED_OAUTH_CLIENT_GRACE_MILLISECONDS;
const MCP_RESOURCE = "https://yepnope.app/mcp";
const SCOPES = JSON.stringify(["openid", "offline_access", "yepnope:questions"]);

async function registerClient(installation: string, createdAt: number): Promise<string> {
	const clientId = `dcr-${installation}`;
	await env.DB.prepare(
		"INSERT INTO oauth_client (id, client_id, created_at, updated_at, name, redirect_uris) " +
			"VALUES (?, ?, ?, ?, ?, ?)",
	)
		.bind(`row-${installation}`, clientId, createdAt, createdAt, "codex", '["http://127.0.0.1:1455/callback"]')
		.run();
	return clientId;
}

async function grantConsent(clientId: string, userId: string, createdAt: number): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO oauth_consent (id, client_id, user_id, resources, scopes, created_at, updated_at) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(`consent-${clientId}`, clientId, userId, JSON.stringify([MCP_RESOURCE]), SCOPES, createdAt, createdAt)
		.run();
}

async function createAccount(userId: string): Promise<string> {
	await env.DB.prepare(
		"INSERT OR IGNORE INTO user (id, email, email_verified, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
	)
		.bind(userId, `${userId}@example.com`, CUTOFF, CUTOFF)
		.run();
	return userId;
}

async function issueRefreshToken(clientId: string, userId: string, createdAt: number): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO oauth_refresh_token (id, token, client_id, user_id, expires_at, created_at, scopes) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(`refresh-${clientId}`, `refresh-token-${clientId}`, clientId, userId, createdAt, createdAt, SCOPES)
		.run();
}

async function issueAccessToken(clientId: string, createdAt: number): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO oauth_access_token (id, token, client_id, expires_at, created_at, scopes) VALUES (?, ?, ?, ?, ?, ?)",
	)
		.bind(`access-${clientId}`, `access-token-${clientId}`, clientId, createdAt, createdAt, SCOPES)
		.run();
}

async function startAuthorization(clientId: string, expiresAt: number): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO verification (id, identifier, value, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)",
	)
		.bind(
			`verification-${clientId}`,
			`authorization-code-${clientId}`,
			JSON.stringify({
				type: "authorization_code",
				query: {client_id: clientId, redirect_uri: "http://127.0.0.1"},
			}),
			expiresAt,
			CUTOFF,
		)
		.run();
}

async function attachResource(clientId: string): Promise<void> {
	await env.DB.batch([
		env.DB.prepare("INSERT OR IGNORE INTO oauth_resource (id, identifier, name) VALUES (?, ?, ?)").bind(
			"resource-row",
			MCP_RESOURCE,
			"YepNope MCP",
		),
		env.DB.prepare("INSERT INTO oauth_client_resource (id, client_id, resource_id) VALUES (?, ?, ?)").bind(
			`client-resource-${clientId}`,
			clientId,
			MCP_RESOURCE,
		),
	]);
}

async function survivingClientIds(): Promise<string[]> {
	const clients = await env.DB.prepare("SELECT client_id FROM oauth_client ORDER BY client_id").all<{
		client_id: string;
	}>();
	return clients.results.map((client) => client.client_id);
}

async function danglingClientResources(): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT count(*) AS value FROM oauth_client_resource WHERE NOT EXISTS " +
			"(SELECT 1 FROM oauth_client WHERE oauth_client.client_id = oauth_client_resource.client_id)",
	).first<{value: number}>();
	return row?.value ?? -1;
}

const NOTHING_RECLAIMED: OAuthClientReclamationResult = {
	abandonedOAuthClients: 0,
	reclaimedOAuthClientResources: 0,
};

describe("abandoned OAuth client reclamation", () => {
	// 🧼 The suite shares one D1, and every assertion here counts whole tables, so each test starts
	// from an empty registration ledger rather than from whatever the last one left behind.
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM oauth_client_resource"),
			env.DB.prepare("DELETE FROM oauth_access_token"),
			env.DB.prepare("DELETE FROM oauth_refresh_token"),
			env.DB.prepare("DELETE FROM oauth_consent"),
			env.DB.prepare("DELETE FROM oauth_client"),
			env.DB.prepare("DELETE FROM verification"),
		]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("never selects a client holding a consent or a token of either kind", async () => {
		const userId = await createAccount("grant-holder");
		const consented = await registerClient("consented", CUTOFF);
		const refreshed = await registerClient("refreshed", CUTOFF);
		const accessed = await registerClient("accessed", CUTOFF);
		await registerClient("abandoned", CUTOFF);
		await grantConsent(consented, userId, CUTOFF);
		await issueRefreshToken(refreshed, userId, CUTOFF);
		await issueAccessToken(accessed, CUTOFF);

		const planned = await planAbandonedOAuthClientReclamation(env.DB, NOW);
		const reclaimed = await reclaimAbandonedOAuthClients(env.DB, NOW);

		expect({planned, reclaimed, surviving: await survivingClientIds()}).toStrictEqual({
			planned: {abandonedOAuthClients: 1, reclaimedOAuthClientResources: 0},
			reclaimed: {abandonedOAuthClients: 1, reclaimedOAuthClientResources: 0},
			surviving: [accessed, consented, refreshed].sort((left, right) => left.localeCompare(right)),
		});
	});

	it("reclaims a client at the grace boundary and keeps the one a millisecond younger", async () => {
		await registerClient("at-boundary", CUTOFF);
		const insideWindow = await registerClient("inside-window", CUTOFF + 1);

		const reclaimed = await reclaimAbandonedOAuthClients(env.DB, NOW);

		expect({reclaimed, surviving: await survivingClientIds()}).toStrictEqual({
			reclaimed: {abandonedOAuthClients: 1, reclaimedOAuthClientResources: 0},
			surviving: [insideWindow],
		});
	});

	it("keeps a client whose authorization is still in flight and takes it once that expires", async () => {
		const inFlight = await registerClient("in-flight", CUTOFF);
		const lapsed = await registerClient("lapsed", CUTOFF);
		// 🔎 One authorization that could still be exchanged, one whose code has already lapsed.
		await startAuthorization(inFlight, NOW + 1);
		await startAuthorization(lapsed, NOW);

		const firstPass = await reclaimAbandonedOAuthClients(env.DB, NOW);
		await env.DB.prepare("UPDATE verification SET expires_at = ? WHERE id = ?")
			.bind(NOW, `verification-${inFlight}`)
			.run();
		const secondPass = await reclaimAbandonedOAuthClients(env.DB, NOW);

		expect({firstPass, secondPass, surviving: await survivingClientIds()}).toStrictEqual({
			firstPass: {abandonedOAuthClients: 1, reclaimedOAuthClientResources: 0},
			secondPass: {abandonedOAuthClients: 1, reclaimedOAuthClientResources: 0},
			surviving: [],
		});
	});

	it("spares a client that gains a grant after it was reported as reclaimable", async () => {
		const userId = await createAccount("late-consenter");
		const client = await registerClient("late-consent", CUTOFF);

		const planned = await planAbandonedOAuthClientReclamation(env.DB, NOW);
		await grantConsent(client, userId, NOW);
		const reclaimed = await reclaimAbandonedOAuthClients(env.DB, NOW);

		expect({planned, reclaimed, surviving: await survivingClientIds()}).toStrictEqual({
			planned: {abandonedOAuthClients: 1, reclaimedOAuthClientResources: 0},
			reclaimed: NOTHING_RECLAIMED,
			surviving: [client],
		});
	});

	it("takes the dependent resource rows with the client and leaves nothing dangling", async () => {
		const userId = await createAccount("resource-owner");
		const abandoned = await registerClient("with-resource", CUTOFF);
		const kept = await registerClient("kept-with-resource", CUTOFF);
		await attachResource(abandoned);
		await attachResource(kept);
		await grantConsent(kept, userId, CUTOFF);

		const planned = await planAbandonedOAuthClientReclamation(env.DB, NOW);
		const reclaimed = await reclaimAbandonedOAuthClients(env.DB, NOW);

		expect({
			dangling: await danglingClientResources(),
			planned,
			reclaimed,
			surviving: await survivingClientIds(),
		}).toStrictEqual({
			dangling: 0,
			planned: {abandonedOAuthClients: 1, reclaimedOAuthClientResources: 1},
			reclaimed: {abandonedOAuthClients: 1, reclaimedOAuthClientResources: 1},
			surviving: [kept],
		});
	});

	it("reports nothing left to do on a second pass and on an empty table", async () => {
		await registerClient("idempotent", CUTOFF);

		const first = await reclaimAbandonedOAuthClients(env.DB, NOW);
		const second = await reclaimAbandonedOAuthClients(env.DB, NOW);
		const planned = await planAbandonedOAuthClientReclamation(env.DB, NOW);

		expect({first, planned, second}).toStrictEqual({
			first: {abandonedOAuthClients: 1, reclaimedOAuthClientResources: 0},
			planned: NOTHING_RECLAIMED,
			second: NOTHING_RECLAIMED,
		});
	});

	it("runs on the cron and records counts without naming a client", async () => {
		const client = await registerClient("observed", CUTOFF);
		const observations: string[] = [];
		vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
			observations.push(String(line));
		});

		const executionContext = createExecutionContext();
		worker.scheduled(
			createScheduledController({cron: "0 4 * * *", scheduledTime: new Date(NOW)}),
			env,
			executionContext,
		);
		await waitOnExecutionContext(executionContext);

		const recorded = observations.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(recorded).toStrictEqual([
			{
				abandonedOAuthClients: 1,
				event: "scheduled_cleanup_completed",
				expiredLegacyIdentities: 0,
				expiredPairingCodes: 0,
				inactiveOAuthAccessTokens: 0,
				inactiveOAuthRefreshTokens: 0,
				reclaimedOAuthClientResources: 0,
				revokedTokens: 0,
			},
		]);
		expect(observations.join("").includes(client)).toBe(false);
		expect(await survivingClientIds()).toStrictEqual([]);
	});
});
