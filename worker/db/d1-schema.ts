import {sql} from "drizzle-orm";
import {index, integer, primaryKey, sqliteTable, text, uniqueIndex} from "drizzle-orm/sqlite-core";

// 🗄️ Better Auth owns account identity; D1 resolves account-owned credentials before DO routing.

export const users = sqliteTable("user", {
	id: text("id").primaryKey(),
	// Better Auth 1.7 still resolves this core field through its adapter. It remains null and is never returned.
	name: text("name"),
	email: text("email").notNull().unique(),
	emailVerified: integer("email_verified", {mode: "boolean"}).default(false).notNull(),
	image: text("image"),
	createdAt: integer("created_at", {mode: "timestamp_ms"})
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.notNull(),
	updatedAt: integer("updated_at", {mode: "timestamp_ms"})
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.$onUpdate(() => new Date())
		.notNull(),
});

export const sessions = sqliteTable(
	"session",
	{
		id: text("id").primaryKey(),
		expiresAt: integer("expires_at", {mode: "timestamp_ms"}).notNull(),
		token: text("token").notNull().unique(),
		createdAt: integer("created_at", {mode: "timestamp_ms"})
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer("updated_at", {mode: "timestamp_ms"})
			.$onUpdate(() => new Date())
			.notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, {onDelete: "cascade"}),
	},
	(table) => [index("session_user_id_idx").on(table.userId)],
);

export const accounts = sqliteTable(
	"account",
	{
		id: text("id").primaryKey(),
		issuer: text("issuer").notNull(),
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, {onDelete: "cascade"}),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: integer("access_token_expires_at", {mode: "timestamp_ms"}),
		refreshTokenExpiresAt: integer("refresh_token_expires_at", {mode: "timestamp_ms"}),
		scope: text("scope"),
		password: text("password"),
		createdAt: integer("created_at", {mode: "timestamp_ms"})
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer("updated_at", {mode: "timestamp_ms"})
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex("account_issuer_account_id_unique").on(table.issuer, table.accountId),
		index("account_user_id_idx").on(table.userId),
	],
);

export const verifications = sqliteTable(
	"verification",
	{
		id: text("id").primaryKey(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: integer("expires_at", {mode: "timestamp_ms"}).notNull(),
		createdAt: integer("created_at", {mode: "timestamp_ms"})
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer("updated_at", {mode: "timestamp_ms"})
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const passkeys = sqliteTable(
	"passkey",
	{
		id: text("id").primaryKey(),
		name: text("name"),
		publicKey: text("public_key").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, {onDelete: "cascade"}),
		credentialID: text("credential_id").notNull(),
		counter: integer("counter").notNull(),
		deviceType: text("device_type").notNull(),
		backedUp: integer("backed_up", {mode: "boolean"}).notNull(),
		transports: text("transports"),
		aaguid: text("aaguid"),
		createdAt: integer("created_at", {mode: "timestamp_ms"})
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [
		uniqueIndex("passkey_credential_id_unique").on(table.credentialID),
		index("passkey_user_id_idx").on(table.userId),
	],
);

export const jsonWebKeys = sqliteTable("jwks", {
	id: text("id").primaryKey(),
	publicKey: text("public_key").notNull(),
	privateKey: text("private_key").notNull(),
	createdAt: integer("created_at", {mode: "timestamp_ms"}).notNull(),
	expiresAt: integer("expires_at", {mode: "timestamp_ms"}),
	alg: text("alg"),
	crv: text("crv"),
});

export const oauthClients = sqliteTable(
	"oauth_client",
	{
		id: text("id").primaryKey(),
		clientId: text("client_id").notNull().unique(),
		clientSecret: text("client_secret"),
		clientDiscoveryId: text("client_discovery_id"),
		disabled: integer("disabled", {mode: "boolean"}).default(false),
		skipConsent: integer("skip_consent", {mode: "boolean"}),
		enableEndSession: integer("enable_end_session", {mode: "boolean"}),
		subjectType: text("subject_type"),
		scopes: text("scopes").$type<string[]>(),
		clientCredentialsScopes: text("client_credentials_scopes").$type<string[]>().default([]),
		userId: text("user_id").references(() => users.id, {onDelete: "cascade"}),
		createdAt: integer("created_at", {mode: "timestamp_ms"}),
		updatedAt: integer("updated_at", {mode: "timestamp_ms"}),
		name: text("name"),
		uri: text("uri"),
		icon: text("icon"),
		contacts: text("contacts").$type<string[]>(),
		tos: text("tos"),
		policy: text("policy"),
		softwareId: text("software_id"),
		softwareVersion: text("software_version"),
		softwareStatement: text("software_statement"),
		redirectUris: text("redirect_uris").$type<string[]>().notNull(),
		postLogoutRedirectUris: text("post_logout_redirect_uris").$type<string[]>(),
		backchannelLogoutUri: text("backchannel_logout_uri"),
		backchannelLogoutSessionRequired: integer("backchannel_logout_session_required", {mode: "boolean"}),
		tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
		applicationType: text("application_type"),
		jwks: text("jwks"),
		jwksUri: text("jwks_uri"),
		grantTypes: text("grant_types").$type<string[]>(),
		responseTypes: text("response_types").$type<string[]>(),
		requirePKCE: integer("require_pkce", {mode: "boolean"}),
		dpopBoundAccessTokens: integer("dpop_bound_access_tokens", {mode: "boolean"}).default(false),
		referenceId: text("reference_id"),
		metadata: text("metadata").$type<Record<string, unknown>>(),
	},
	(table) => [index("oauth_client_user_id_idx").on(table.userId)],
);

export const oauthResources = sqliteTable("oauth_resource", {
	id: text("id").primaryKey(),
	identifier: text("identifier").notNull().unique(),
	name: text("name").notNull(),
	accessTokenTtl: integer("access_token_ttl"),
	refreshTokenTtl: integer("refresh_token_ttl"),
	signingAlgorithm: text("signing_algorithm"),
	signingKeyId: text("signing_key_id"),
	allowedScopes: text("allowed_scopes").$type<string[]>(),
	customClaims: text("custom_claims").$type<Record<string, unknown>>(),
	dpopBoundAccessTokensRequired: integer("dpop_bound_access_tokens_required", {mode: "boolean"}).default(false),
	disabled: integer("disabled", {mode: "boolean"}).default(false),
	createdAt: integer("created_at", {mode: "timestamp_ms"}),
	updatedAt: integer("updated_at", {mode: "timestamp_ms"}),
	policyVersion: integer("policy_version").default(1),
	metadata: text("metadata").$type<Record<string, unknown>>(),
});

export const oauthClientResources = sqliteTable(
	"oauth_client_resource",
	{
		id: text("id").primaryKey(),
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClients.clientId, {onDelete: "cascade"}),
		resourceId: text("resource_id")
			.notNull()
			.references(() => oauthResources.identifier, {onDelete: "cascade"}),
		metadata: text("metadata").$type<Record<string, unknown>>(),
		createdAt: integer("created_at", {mode: "timestamp_ms"}),
	},
	(table) => [
		index("oauth_client_resource_client_id_idx").on(table.clientId),
		index("oauth_client_resource_resource_id_idx").on(table.resourceId),
		uniqueIndex("oauth_client_resource_client_id_resource_id_unique").on(table.clientId, table.resourceId),
	],
);

export const oauthRefreshTokens = sqliteTable(
	"oauth_refresh_token",
	{
		id: text("id").primaryKey(),
		token: text("token").notNull().unique(),
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClients.clientId, {onDelete: "cascade"}),
		sessionId: text("session_id").references(() => sessions.id, {onDelete: "set null"}),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, {onDelete: "cascade"}),
		referenceId: text("reference_id"),
		authorizationCodeId: text("authorization_code_id"),
		resources: text("resources").$type<string[]>(),
		requestedUserInfoClaims: text("requested_user_info_claims").$type<string[]>(),
		expiresAt: integer("expires_at", {mode: "timestamp_ms"}).notNull(),
		createdAt: integer("created_at", {mode: "timestamp_ms"}).notNull(),
		revoked: integer("revoked", {mode: "timestamp_ms"}),
		rotatedAt: integer("rotated_at", {mode: "timestamp_ms"}),
		rotationReplayResponse: text("rotation_replay_response"),
		rotationReplayExpiresAt: integer("rotation_replay_expires_at", {mode: "timestamp_ms"}),
		authTime: integer("auth_time", {mode: "timestamp_ms"}),
		confirmation: text("confirmation").$type<Record<string, unknown>>(),
		scopes: text("scopes").$type<string[]>().notNull(),
	},
	(table) => [
		index("oauth_refresh_token_client_id_idx").on(table.clientId),
		index("oauth_refresh_token_session_id_idx").on(table.sessionId),
		index("oauth_refresh_token_user_id_idx").on(table.userId),
		index("oauth_refresh_token_authorization_code_id_idx").on(table.authorizationCodeId),
	],
);

export const oauthAccessTokens = sqliteTable(
	"oauth_access_token",
	{
		id: text("id").primaryKey(),
		token: text("token").notNull().unique(),
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClients.clientId, {onDelete: "cascade"}),
		sessionId: text("session_id").references(() => sessions.id, {onDelete: "set null"}),
		userId: text("user_id").references(() => users.id, {onDelete: "cascade"}),
		referenceId: text("reference_id"),
		authorizationCodeId: text("authorization_code_id"),
		resources: text("resources").$type<string[]>(),
		requestedUserInfoClaims: text("requested_user_info_claims").$type<string[]>(),
		refreshId: text("refresh_id").references(() => oauthRefreshTokens.id, {onDelete: "cascade"}),
		expiresAt: integer("expires_at", {mode: "timestamp_ms"}).notNull(),
		createdAt: integer("created_at", {mode: "timestamp_ms"}).notNull(),
		revoked: integer("revoked", {mode: "timestamp_ms"}),
		confirmation: text("confirmation").$type<Record<string, unknown>>(),
		scopes: text("scopes").$type<string[]>().notNull(),
	},
	(table) => [
		index("oauth_access_token_client_id_idx").on(table.clientId),
		index("oauth_access_token_session_id_idx").on(table.sessionId),
		index("oauth_access_token_user_id_idx").on(table.userId),
		index("oauth_access_token_authorization_code_id_idx").on(table.authorizationCodeId),
		index("oauth_access_token_refresh_id_idx").on(table.refreshId),
	],
);

export const oauthConsents = sqliteTable(
	"oauth_consent",
	{
		id: text("id").primaryKey(),
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClients.clientId, {onDelete: "cascade"}),
		userId: text("user_id").references(() => users.id, {onDelete: "cascade"}),
		referenceId: text("reference_id"),
		resources: text("resources").$type<string[]>(),
		requestedUserInfoClaims: text("requested_user_info_claims").$type<string[]>(),
		scopes: text("scopes").$type<string[]>().notNull(),
		createdAt: integer("created_at", {mode: "timestamp_ms"}).notNull(),
		updatedAt: integer("updated_at", {mode: "timestamp_ms"}).notNull(),
	},
	(table) => [
		index("oauth_consent_client_id_idx").on(table.clientId),
		index("oauth_consent_user_id_idx").on(table.userId),
	],
);

export const oauthClientAssertions = sqliteTable("oauth_client_assertion", {
	id: text("id").primaryKey(),
	expiresAt: integer("expires_at", {mode: "timestamp_ms"}).notNull(),
});

// ⏱️ The clock Settings shows beside a connected client, and the first thing anyone asking "is this
// connection actually live?" reads. It is deliberately not a request log: one row per authorization,
// holding a coarse timestamp and nothing a caller supplied — no question, no tool input, no address.
export const mcpClientUses = sqliteTable(
	"mcp_client_use",
	{
		userId: text("user_id")
			.notNull()
			.references(() => users.id, {onDelete: "cascade"}),
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClients.clientId, {onDelete: "cascade"}),
		lastUsedAt: integer("last_used_at").notNull(),
	},
	(table) => [primaryKey({columns: [table.userId, table.clientId]})],
);

// 📟 RFC 8628. The Claude Code hook is a local command with no browser and no redirect URI, so it
// asks for a user code here and the account approves it in the app. `oauthClientId` and `resources`
// are the OAuth provider's own additions: they are what turn an approved code into a scoped,
// audience-bound, refreshable token set rather than a first-party session.
export const deviceCodes = sqliteTable(
	"device_code",
	{
		id: text("id").primaryKey(),
		deviceCode: text("device_code").notNull().unique(),
		userCode: text("user_code").notNull().unique(),
		userId: text("user_id").references(() => users.id, {onDelete: "cascade"}),
		expiresAt: integer("expires_at", {mode: "timestamp_ms"}).notNull(),
		status: text("status").notNull(),
		lastPolledAt: integer("last_polled_at", {mode: "timestamp_ms"}),
		pollingInterval: integer("polling_interval"),
		clientId: text("client_id"),
		scope: text("scope"),
		resources: text("resources").$type<string[]>(),
		oauthClientId: text("oauth_client_id"),
	},
	(table) => [index("device_code_user_id_idx").on(table.userId)],
);

export const identityLifecycles = sqliteTable(
	"identity_lifecycles",
	{
		identityId: text("identity_id").primaryKey(),
		identityType: text("identity_type", {enum: ["account"]}).notNull(),
		ownerUserId: text("owner_user_id"),
		createdAt: integer("created_at").notNull(),
		expiresAt: integer("expires_at"),
		claimedAt: integer("claimed_at"),
		deletionRequestedAt: integer("deletion_requested_at"),
		deletedAt: integer("deleted_at"),
	},
	(table) => [
		index("identity_lifecycles_owner_user_id_idx").on(table.ownerUserId),
		index("identity_lifecycles_expires_at_idx").on(table.expiresAt),
	],
);

export const durableObjectCleanupJobs = sqliteTable(
	"durable_object_cleanup_jobs",
	{
		objectName: text("object_name").primaryKey(),
		ownerUserId: text("owner_user_id"),
		reason: text("reason", {enum: ["account_deleted"]}).notNull(),
		requestedAt: integer("requested_at").notNull(),
		completedAt: integer("completed_at"),
	},
	(table) => [index("durable_object_cleanup_jobs_completed_at_idx").on(table.completedAt)],
);
