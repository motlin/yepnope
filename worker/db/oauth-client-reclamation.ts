// 🧹 Dynamic Client Registration lets any MCP client register itself before anyone consents, so an
// abandoned `codex mcp login` leaves a row behind. Nothing else in the system ever reclaims one, so
// without this predicate `oauth_client` grows once per attempt, forever.
//
// This module is deliberately free of Worker types: the Worker executes these statements with bound
// parameters, and `scripts/oauth-client-reclamation.ts` runs the read-only halves through
// `wrangler d1 execute`, which cannot bind anything.

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

/**
 * How long a registered client with no consent and no token is kept before it is reclaimed.
 *
 * The whole authorization ceremony is far shorter than this. A registration is followed by a
 * five-minute authorization code (`OAUTH_AUTHORIZATION_CODE_EXPIRY_SECONDS`), and the consent step
 * in between carries its state in a signed query string rather than in the database. Seven days is
 * three orders of magnitude beyond that, so no ceremony that could still complete is ever reaped.
 */
export const ABANDONED_OAUTH_CLIENT_GRACE_MILLISECONDS = 7 * DAY_MILLISECONDS;

// 🔎 An in-flight authorization persists exactly one row: a `verification` whose value is the JSON
// authorization-code grant, and whose `query` carries the client id. Matching it is belt and braces
// over the grace window. A client id holding a LIKE wildcard could only widen this match, which
// keeps a client alive rather than reaping one, so the unescaped concatenation is safe by direction.
const IN_FLIGHT_AUTHORIZATION_MATCH = `'%"client_id":"' || oauth_client.client_id || '"%'`;

/**
 * A client is abandoned when it is older than the grace window, holds no consent, holds no token of
 * either kind, and has no unexpired authorization in flight. Bind `[cutoff, now]`.
 */
const ABANDONED_OAUTH_CLIENT_PREDICATE =
	"oauth_client.created_at IS NOT NULL AND oauth_client.created_at <= ? " +
	"AND NOT EXISTS (SELECT 1 FROM oauth_consent WHERE oauth_consent.client_id = oauth_client.client_id) " +
	"AND NOT EXISTS (SELECT 1 FROM oauth_refresh_token WHERE oauth_refresh_token.client_id = oauth_client.client_id) " +
	"AND NOT EXISTS (SELECT 1 FROM oauth_access_token WHERE oauth_access_token.client_id = oauth_client.client_id) " +
	"AND NOT EXISTS (SELECT 1 FROM verification WHERE verification.expires_at > ? " +
	`AND verification.value LIKE ${IN_FLIGHT_AUTHORIZATION_MATCH})`;

const SURVIVING_OAUTH_CLIENT_EXISTS =
	"EXISTS (SELECT 1 FROM oauth_client WHERE oauth_client.client_id = oauth_client_resource.client_id " +
	`AND NOT (${ABANDONED_OAUTH_CLIENT_PREDICATE}))`;

export const ABANDONED_OAUTH_CLIENT_COUNT_SQL = `SELECT count(*) AS value FROM oauth_client WHERE ${ABANDONED_OAUTH_CLIENT_PREDICATE}`;

/** Every dependent row that loses its client, including any already orphaned before this run. */
export const RECLAIMABLE_OAUTH_CLIENT_RESOURCE_COUNT_SQL = `SELECT count(*) AS value FROM oauth_client_resource WHERE NOT ${SURVIVING_OAUTH_CLIENT_EXISTS}`;

/**
 * The three statements that reclaim abandoned clients, in the order they must run inside a single
 * D1 batch. Dependents go first while their clients still exist, so the count is exact whether or
 * not the platform fires the declared `ON DELETE cascade`; the trailing sweep takes any row that was
 * already dangling. Because the batch is one transaction, selection and deletion see one snapshot,
 * so a client that gains a consent or a token concurrently is protected by every statement at once.
 */
export const ABANDONED_OAUTH_CLIENT_RESOURCE_DELETE_SQL = `DELETE FROM oauth_client_resource WHERE EXISTS (SELECT 1 FROM oauth_client WHERE oauth_client.client_id = oauth_client_resource.client_id AND (${ABANDONED_OAUTH_CLIENT_PREDICATE}))`;

export const ABANDONED_OAUTH_CLIENT_DELETE_SQL = `DELETE FROM oauth_client WHERE ${ABANDONED_OAUTH_CLIENT_PREDICATE}`;

export const ORPHANED_OAUTH_CLIENT_RESOURCE_DELETE_SQL =
	"DELETE FROM oauth_client_resource WHERE NOT EXISTS " +
	"(SELECT 1 FROM oauth_client WHERE oauth_client.client_id = oauth_client_resource.client_id)";

/** The `[cutoff, now]` pair every parameterized statement above expects, in order. */
export function abandonedOAuthClientBindings(now: number): [number, number] {
	return [now - ABANDONED_OAUTH_CLIENT_GRACE_MILLISECONDS, now];
}

/**
 * The same statement with its timestamps written out as integer literals, for `wrangler d1 execute`,
 * which offers no way to bind a parameter. Both values are computed here from a clock reading, so
 * nothing user-supplied is ever spliced into SQL.
 */
export function withInlineTimestamps(sql: string, now: number): string {
	const bindings = abandonedOAuthClientBindings(now);
	let consumed = 0;
	const inlined = sql.replaceAll("?", () => {
		const binding = bindings[consumed];
		if (binding === undefined) {
			throw new Error(`${sql} takes more than ${bindings.length} bindings`);
		}
		consumed += 1;
		return String(binding);
	});
	if (consumed !== bindings.length) {
		throw new Error(`${sql} takes ${consumed} bindings, not ${bindings.length}`);
	}
	return inlined;
}
