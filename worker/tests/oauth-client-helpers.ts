import {env} from "cloudflare:workers";
import {hashToken, OAUTH_SCOPES} from "../auth";

const MCP_RESOURCE = "https://yepnope.app/mcp";

export interface SeededOAuthMcpClient {
	clientId: string;
	managementId: string;
	refreshTokenId: string;
}

export async function seedOAuthMcpClient(
	userId: string,
	installation: string,
	options: {authorizedAt?: number; expiresAt?: number; name?: string} = {},
): Promise<SeededOAuthMcpClient> {
	const authorizedAt = options.authorizedAt ?? Date.UTC(2000, 0, 1);
	const expiresAt = options.expiresAt ?? Date.UTC(2099, 0, 1);
	const clientId = `test-oauth-client-${installation}`;
	const clientRowId = `test-oauth-client-row-${installation}`;
	const consentId = `test-oauth-consent-${installation}`;
	const refreshTokenId = `test-oauth-refresh-${installation}`;
	const serializedScopes = JSON.stringify([...OAUTH_SCOPES]);
	const serializedResources = JSON.stringify([MCP_RESOURCE]);
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO oauth_client (id, client_id, user_id, created_at, updated_at, name, redirect_uris) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?)",
		).bind(
			clientRowId,
			clientId,
			userId,
			authorizedAt,
			authorizedAt,
			options.name ?? `Test MCP client ${installation}`,
			JSON.stringify([`http://127.0.0.1/callback/${installation}`]),
		),
		env.DB.prepare(
			"INSERT INTO oauth_consent " +
				"(id, client_id, user_id, resources, scopes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).bind(consentId, clientId, userId, serializedResources, serializedScopes, authorizedAt, authorizedAt),
		env.DB.prepare(
			"INSERT INTO oauth_refresh_token " +
				"(id, token, client_id, user_id, resources, expires_at, created_at, scopes) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).bind(
			refreshTokenId,
			`stored-test-refresh-token-${installation}`,
			clientId,
			userId,
			serializedResources,
			expiresAt,
			authorizedAt,
			serializedScopes,
		),
	]);
	return {
		clientId,
		managementId: await hashToken(`connected-mcp-client\0${userId}\0${clientId}`),
		refreshTokenId,
	};
}
