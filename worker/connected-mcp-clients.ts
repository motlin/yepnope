import {z} from "zod";
import {hashToken} from "./auth";
import type {UserDurableObject} from "./user-do";

const QUESTION_SCOPE = "yepnope:questions";
const storedStringArraySchema = z.array(z.string());

interface OAuthGrantRow {
	client_id: string;
	client_disabled: number | null;
	client_name: string | null;
	consent_created_at: number;
	consent_resources: string | null;
	consent_scopes: string;
	refresh_created_at: number | null;
	refresh_expires_at: number | null;
	refresh_resources: string | null;
	refresh_revoked_at: number | null;
	refresh_scopes: string | null;
}

interface OAuthClientAuthorization {
	clientId: string;
	displayName: string;
	authorizedAt: number;
	grantedScopes: string[];
	active: boolean;
	revokedAt: number | null;
}

interface ConnectedMcpClientAuthorizationState {
	activeClientCount: number;
}

interface ConnectedMcpClient {
	id: string;
	displayName: string;
	authorizedAt: number;
	lastUsedAt: number | null;
	grantedScopes: string[];
	status: "active" | "expired" | "revoked";
	revokedAt: number | null;
}

function parseStoredStringArray(value: string | null): string[] {
	return value === null ? [] : storedStringArraySchema.parse(JSON.parse(value) as unknown);
}

function authorizesResource(resources: string | null, scopes: string | null, resource: string): boolean {
	return (
		parseStoredStringArray(resources).includes(resource) && parseStoredStringArray(scopes).includes(QUESTION_SCOPE)
	);
}

async function oauthClientAuthorizations(
	database: D1Database,
	userId: string,
	resource: string,
	now: number,
): Promise<OAuthClientAuthorization[]> {
	const result = await database
		.prepare(
			"SELECT consent.client_id, client.name AS client_name, client.disabled AS client_disabled, " +
				"consent.created_at AS consent_created_at, consent.resources AS consent_resources, " +
				"consent.scopes AS consent_scopes, refresh.created_at AS refresh_created_at, " +
				"refresh.expires_at AS refresh_expires_at, refresh.revoked AS refresh_revoked_at, " +
				"refresh.resources AS refresh_resources, refresh.scopes AS refresh_scopes " +
				"FROM oauth_consent AS consent " +
				"JOIN oauth_client AS client ON client.client_id = consent.client_id " +
				"LEFT JOIN oauth_refresh_token AS refresh " +
				"ON refresh.client_id = consent.client_id AND refresh.user_id = consent.user_id " +
				"WHERE consent.user_id = ? ORDER BY consent.created_at, consent.client_id, refresh.created_at",
		)
		.bind(userId)
		.all<OAuthGrantRow>();
	const authorizations = new Map<string, OAuthClientAuthorization>();
	for (const row of result.results) {
		if (!authorizesResource(row.consent_resources, row.consent_scopes, resource)) {
			continue;
		}
		const existing = authorizations.get(row.client_id);
		const authorization = existing ?? {
			clientId: row.client_id,
			displayName: row.client_name ?? "MCP client",
			authorizedAt: row.consent_created_at,
			grantedScopes: parseStoredStringArray(row.consent_scopes).sort(),
			active: false,
			revokedAt: null,
		};
		authorization.authorizedAt = Math.min(authorization.authorizedAt, row.consent_created_at);
		const refreshIsActive =
			row.client_disabled !== 1 &&
			row.refresh_expires_at !== null &&
			row.refresh_expires_at > now &&
			row.refresh_revoked_at === null &&
			authorizesResource(row.refresh_resources, row.refresh_scopes, resource);
		authorization.active ||= refreshIsActive;
		if (row.refresh_revoked_at !== null) {
			authorization.revokedAt = Math.max(authorization.revokedAt ?? 0, row.refresh_revoked_at);
		}
		authorizations.set(row.client_id, authorization);
	}
	return [...authorizations.values()];
}

async function managementId(userId: string, clientId: string): Promise<string> {
	return hashToken(`connected-mcp-client\0${userId}\0${clientId}`);
}

export async function getConnectedMcpClientAuthorizationState(
	database: D1Database,
	userId: string,
	resource: string,
	now = Date.now(),
): Promise<ConnectedMcpClientAuthorizationState> {
	const authorizations = await oauthClientAuthorizations(database, userId, resource, now);
	return {activeClientCount: authorizations.filter(({active}) => active).length};
}

export async function listConnectedMcpClients(
	database: D1Database,
	userId: string,
	resource: string,
	now = Date.now(),
): Promise<ConnectedMcpClient[]> {
	const authorizations = await oauthClientAuthorizations(database, userId, resource, now);
	return Promise.all(
		authorizations.map(async (authorization) => ({
			id: await managementId(userId, authorization.clientId),
			displayName: authorization.displayName,
			authorizedAt: authorization.authorizedAt,
			lastUsedAt: null,
			grantedScopes: authorization.grantedScopes,
			status: authorization.active ? "active" : authorization.revokedAt === null ? "expired" : "revoked",
			revokedAt: authorization.active ? null : authorization.revokedAt,
		})),
	);
}

export async function revokeConnectedMcpClient(
	database: D1Database,
	namespace: DurableObjectNamespace<UserDurableObject>,
	userId: string,
	resource: string,
	connectedMcpClientId: string,
	revokedAt: number,
): Promise<boolean> {
	const authorizations = await oauthClientAuthorizations(database, userId, resource, revokedAt);
	let ownedClientId: string | undefined;
	for (const authorization of authorizations) {
		if (authorization.active && (await managementId(userId, authorization.clientId)) === connectedMcpClientId) {
			ownedClientId = authorization.clientId;
			break;
		}
	}
	if (ownedClientId === undefined) {
		return false;
	}
	await database.batch([
		database
			.prepare(
				"UPDATE oauth_refresh_token SET revoked = ? " +
					"WHERE user_id = ? AND client_id = ? AND revoked IS NULL",
			)
			.bind(revokedAt, userId, ownedClientId),
		database
			.prepare(
				"UPDATE oauth_access_token SET revoked = ? " +
					"WHERE user_id = ? AND client_id = ? AND revoked IS NULL",
			)
			.bind(revokedAt, userId, ownedClientId),
	]);
	const state = await getConnectedMcpClientAuthorizationState(database, userId, resource, revokedAt);
	await namespace.getByName(userId).synchronizeConnectedMcpClientAuthorizationState(state);
	return true;
}
