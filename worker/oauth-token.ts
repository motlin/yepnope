import {createLocalJWKSet, errors, jwtVerify} from "jose";
import {z} from "zod";
import {
	authenticateBrowserSession,
	MCP_RESOURCE_PATH,
	observeWorkerAuthentication,
	withRequestBackgroundTasks,
	workerAuthentication,
} from "./auth";
import {recordConnectedMcpClientUse} from "./connected-mcp-clients";

// 🎟️ One bearer story for every non-browser caller. `/mcp` and the Claude Code hook hold the same
// kind of credential — a short-lived, audience-bound, refreshable OAuth access token issued to a
// registered client — and are refused by the same predicate, so revoking a client in Settings stops
// both without either one keeping a private back door.

export const QUESTION_SCOPE = "yepnope:questions";

const jsonWebKeySetSchema = z.object({keys: z.array(z.record(z.string(), z.unknown()))});
const storedStringArraySchema = z.array(z.string());

// 🪪 `sid` names the browser session an authorization-code grant was minted from. A device grant is
// approved in the app rather than delegated from a live session, so it carries none, and the grant
// check below matches on that absence instead of inventing a session for it. Absent and explicitly
// null both mean the same thing: issuance omits the claim, a refresh writes it as null.
const accessTokenClaimsSchema = z
	.object({
		azp: z.string().min(1),
		client_id: z.string().min(1),
		exp: z.number().int(),
		iat: z.number().int(),
		jti: z.string().min(1),
		scope: z.string().min(1),
		sid: z.string().min(1).nullish(),
		sub: z.string().min(1),
	})
	.loose();

export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

/** The browser session behind a delegated grant, or null when the grant was approved on a device. */
export function grantSessionId(claims: AccessTokenClaims): string | null {
	return claims.sid ?? null;
}

interface ActiveGrantRow {
	consent_resources: string | null;
	consent_scopes: string;
	refresh_resources: string | null;
	refresh_scopes: string;
}

export function mcpResource(environment: Pick<Env, "BETTER_AUTH_URL">): string {
	return `${environment.BETTER_AUTH_URL}${MCP_RESOURCE_PATH}`;
}

export function bearerToken(request: Request): string | null {
	const authorization = request.headers.get("Authorization");
	if (authorization === null || !authorization.startsWith("Bearer ")) {
		return null;
	}
	const token = authorization.slice("Bearer ".length);
	return token.length === 0 || token.includes(" ") ? null : token;
}

function parseStoredStringArray(value: string | null): string[] {
	return value === null ? [] : storedStringArraySchema.parse(JSON.parse(value) as unknown);
}

// 🕵️ Why a bearer token was refused, drawn from a closed vocabulary. The wire never carries it: a
// caller holding a stolen, tampered, or stale token gets the same 401 and the same challenge either
// way, so nothing here tells an attacker which part of their guess was wrong. The operator gets the
// distinction instead, because "the client re-authorizes forever" has a cause every entry below can
// produce, and a bare 401 names none of them.
enum AccessTokenRejection {
	AudienceMismatch = "audience_mismatch",
	// Signed by this deployment, but carrying a claim set no grant can be looked up from.
	ClaimsUnusable = "claims_unusable",
	Expired = "expired",
	IssuerMismatch = "issuer_mismatch",
	JwksMalformed = "jwks_malformed",
	JwksUnavailable = "jwks_unavailable",
	// Not a JWT this deployment could even read: wrong shape, wrong encoding, truncated.
	Malformed = "malformed",
	SignatureInvalid = "signature_invalid",
}

// The deployment cannot read its own signing keys, so every token fails no matter who sent it. That
// is an outage rather than a bad caller, and it is the one case worth waking someone for.
const OPERATOR_FAULT_REJECTIONS = new Set<AccessTokenRejection>([
	AccessTokenRejection.JwksMalformed,
	AccessTokenRejection.JwksUnavailable,
]);

function refuseAccessToken(rejection: AccessTokenRejection): null {
	observeWorkerAuthentication({
		event: "access_token_rejected",
		failure: null,
		level: OPERATOR_FAULT_REJECTIONS.has(rejection) ? "error" : "warn",
		reason: rejection,
		status: null,
	});
	return null;
}

function joseRejection(caught: unknown): AccessTokenRejection {
	if (caught instanceof errors.JWTExpired) {
		return AccessTokenRejection.Expired;
	}
	if (caught instanceof errors.JWTClaimValidationFailed) {
		switch (caught.claim) {
			case "aud":
				return AccessTokenRejection.AudienceMismatch;
			case "iss":
				return AccessTokenRejection.IssuerMismatch;
			default:
				return AccessTokenRejection.ClaimsUnusable;
		}
	}
	if (caught instanceof errors.JWSSignatureVerificationFailed || caught instanceof errors.JWKSNoMatchingKey) {
		return AccessTokenRejection.SignatureInvalid;
	}
	return AccessTokenRejection.Malformed;
}

/** This deployment's own signing keys, or null once the reason they could not be read was recorded. */
async function verificationKeys(
	issuer: string,
	environment: Env,
	executionContext: ExecutionContext,
): Promise<ReturnType<typeof createLocalJWKSet> | null> {
	const response = await withRequestBackgroundTasks(executionContext, async () =>
		workerAuthentication(environment).handler(new Request(`${issuer}/jwks`)),
	).catch(() => null);
	if (response === null || !response.ok) {
		return refuseAccessToken(AccessTokenRejection.JwksUnavailable);
	}
	const jwks = jsonWebKeySetSchema.safeParse(await response.json().catch(() => null));
	return jwks.success ? createLocalJWKSet(jwks.data) : refuseAccessToken(AccessTokenRejection.JwksMalformed);
}

/**
 * Verifies the signature, issuer, audience, and expiry of an access token this deployment minted.
 * Nothing here consults the database: a valid signature only proves the token was issued, which is
 * why every caller pairs this with {@link hasActiveGrant}.
 */
export async function verifyAccessToken(
	token: string,
	environment: Env,
	executionContext: ExecutionContext,
): Promise<AccessTokenClaims | null> {
	const issuer = `${environment.BETTER_AUTH_URL}/api/auth`;
	const keys = await verificationKeys(issuer, environment, executionContext);
	if (keys === null) {
		return null;
	}
	const verified = await jwtVerify(token, keys, {audience: mcpResource(environment), issuer}).catch(
		(caught: unknown) => refuseAccessToken(joseRejection(caught)),
	);
	if (verified === null) {
		return null;
	}
	const parsed = accessTokenClaimsSchema.safeParse(verified.payload);
	return parsed.success ? parsed.data : refuseAccessToken(AccessTokenRejection.ClaimsUnusable);
}

/**
 * 🔌 The live half of authorization, and the reason revocation is immediate: an access token is a
 * self-contained JWT that nobody can recall, so every call re-reads the grant behind it. Revoking a
 * connected client marks its refresh token, this predicate stops finding one, and the still-unexpired
 * access token stops working on its very next use.
 */
export async function hasActiveGrant(
	database: D1Database,
	claims: AccessTokenClaims,
	resource: string,
): Promise<boolean> {
	if (claims.azp !== claims.client_id) {
		return false;
	}
	const now = Date.now();
	const sessionId = grantSessionId(claims);
	// A delegated grant must still have its browser session; a device grant must have none, so a
	// token minted one way can never be validated under the other's rules.
	const sessionJoin =
		sessionId === null
			? "AND refresh.session_id IS NULL "
			: "JOIN session ON session.id = refresh.session_id " +
				"AND session.user_id = refresh.user_id AND session.expires_at > ? ";
	const rows = await database
		.prepare(
			"SELECT refresh.resources AS refresh_resources, refresh.scopes AS refresh_scopes, " +
				"consent.resources AS consent_resources, consent.scopes AS consent_scopes " +
				"FROM oauth_refresh_token AS refresh " +
				"JOIN oauth_client AS client ON client.client_id = refresh.client_id " +
				"JOIN user ON user.id = refresh.user_id " +
				"JOIN oauth_consent AS consent " +
				"ON consent.client_id = refresh.client_id AND consent.user_id = refresh.user_id " +
				sessionJoin +
				"WHERE refresh.user_id = ? AND refresh.client_id = ? " +
				(sessionId === null ? "" : "AND refresh.session_id = ? ") +
				"AND refresh.revoked IS NULL AND refresh.expires_at > ? " +
				"AND COALESCE(client.disabled, 0) = 0 AND user.email_verified = 1",
		)
		.bind(
			...(sessionId === null
				? [claims.sub, claims.client_id, now]
				: [now, claims.sub, claims.client_id, sessionId, now]),
		)
		.all<ActiveGrantRow>();
	const tokenScopes = new Set(claims.scope.split(" "));
	return rows.results.some((row) => {
		const refreshScopes = new Set(parseStoredStringArray(row.refresh_scopes));
		const consentScopes = new Set(parseStoredStringArray(row.consent_scopes));
		return (
			parseStoredStringArray(row.refresh_resources).includes(resource) &&
			parseStoredStringArray(row.consent_resources).includes(resource) &&
			tokenScopes.has(QUESTION_SCOPE) &&
			refreshScopes.has(QUESTION_SCOPE) &&
			consentScopes.has(QUESTION_SCOPE)
		);
	});
}

async function authenticateAccessToken(
	request: Request,
	environment: Env,
	executionContext: ExecutionContext,
): Promise<string | null> {
	const token = bearerToken(request);
	if (token === null) {
		return null;
	}
	const claims = await verifyAccessToken(token, environment, executionContext);
	if (claims === null || !new Set(claims.scope.split(" ")).has(QUESTION_SCOPE)) {
		return null;
	}
	if (!(await hasActiveGrant(environment.DB, claims, mcpResource(environment)))) {
		return null;
	}
	// The hook posts over the same grant the `/mcp` tool call uses, so both count as the client
	// being used. A clock that only moved for tool calls would read "not used yet" for an
	// installation that has been reporting hook events all day.
	await recordConnectedMcpClientUse(environment.DB, claims.sub, claims.client_id, Date.now());
	return claims.sub;
}

/**
 * The identity behind an application request: an OAuth access token for an agent-side caller, or the
 * browser's own session. There is no third credential type, so nothing reaches these routes without
 * an authorization that Settings can revoke.
 */
export async function authenticateRequest(
	request: Request,
	environment: Env,
	executionContext: ExecutionContext,
): Promise<string | null> {
	return (
		(await authenticateAccessToken(request, environment, executionContext)) ??
		(await authenticateBrowserSession(request, environment, executionContext))
	);
}
