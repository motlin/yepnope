import {z} from "zod";
import {OAUTH_SCOPES} from "./auth";

// 📟 The human half of RFC 8628. A local command with no browser prints a short code; the account
// holder reads it into the app and approves it here. Approval is also where consent is recorded,
// because a device grant has no redirect and therefore never passes the consent page: without this
// row the client would hold tokens that Settings could neither list nor revoke.

const OAUTH_SCOPE_SET: ReadonlySet<string> = new Set(OAUTH_SCOPES);

const storedStringArraySchema = z.array(z.string());

interface DeviceCodeRow {
	expires_at: number;
	id: string;
	oauth_client_id: string | null;
	resources: string | null;
	scope: string | null;
	status: string;
	user_id: string | null;
	client_name: string | null;
}

export interface PendingDeviceAuthorization {
	clientName: string;
	scopes: string[];
	userCode: string;
}

export type DeviceAuthorizationDecision = "approved" | "denied";

export type DeviceAuthorizationLookup =
	| {status: "pending"; authorization: PendingDeviceAuthorization}
	| {status: "decided"; decision: DeviceAuthorizationDecision}
	| {status: "expired"}
	| {status: "not_found"};

export type DeviceAuthorizationResult =
	| {status: "decided"; decision: DeviceAuthorizationDecision}
	| {status: "expired"}
	| {status: "not_found"}
	| {status: "taken"};

/**
 * The same normalization Better Auth applies when it looks a code up, so a code typed with the
 * dash it was displayed with, or in lower case, finds the row it names.
 */
function normalizeUserCode(userCode: string): string {
	return userCode.replaceAll(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function parseStoredStringArray(value: string | null): string[] {
	return value === null ? [] : storedStringArraySchema.parse(JSON.parse(value) as unknown);
}

async function findDeviceCode(database: D1Database, userCode: string): Promise<DeviceCodeRow | null> {
	return database
		.prepare(
			"SELECT code.id, code.expires_at, code.oauth_client_id, code.resources, code.scope, " +
				"code.status, code.user_id, client.name AS client_name FROM device_code AS code " +
				"LEFT JOIN oauth_client AS client ON client.client_id = code.oauth_client_id " +
				"WHERE code.user_code = ?",
		)
		.bind(userCode)
		.first<DeviceCodeRow>();
}

function grantedScopes(row: DeviceCodeRow): string[] {
	return (row.scope ?? "")
		.split(" ")
		.filter((scope) => OAUTH_SCOPE_SET.has(scope))
		.sort();
}

type UnavailableDeviceCode = Exclude<DeviceAuthorizationLookup, {status: "pending"}>;
type ClaimedDeviceCode = UnavailableDeviceCode | {status: "pending"; clientId: string; row: DeviceCodeRow};

/**
 * Resolves a typed code to the row this account is allowed to decide.
 *
 * 🥇 Reading a pending code claims it, atomically and for good. A user code is eight characters, so
 * the window in which a second account could type the same one is exactly the window this closes:
 * whoever looks first owns the decision, and everyone else is told the code does not exist.
 */
async function claimDeviceCode(
	database: D1Database,
	userId: string,
	userCode: string,
	resource: string,
	now: number,
): Promise<ClaimedDeviceCode> {
	const normalized = normalizeUserCode(userCode);
	const found = await findDeviceCode(database, normalized);
	const clientId = found?.oauth_client_id ?? null;
	// A code that never asked for this deployment's resource would mint a token that authorizes
	// nothing, so it is not something to put in front of a person as a decision.
	if (found === null || clientId === null || !parseStoredStringArray(found.resources).includes(resource)) {
		return {status: "not_found"};
	}
	if (found.expires_at <= now) {
		return {status: "expired"};
	}
	if (found.user_id === null && found.status === "pending") {
		const claimed = await database
			.prepare("UPDATE device_code SET user_id = ? WHERE id = ? AND status = 'pending' AND user_id IS NULL")
			.bind(userId, found.id)
			.run();
		if (claimed.meta.changes === 0) {
			return {status: "not_found"};
		}
		found.user_id = userId;
	}
	if (found.user_id !== userId) {
		return {status: "not_found"};
	}
	if (found.status === "approved" || found.status === "denied") {
		return {status: "decided", decision: found.status};
	}
	return {status: "pending", clientId, row: found};
}

function pendingAuthorization(row: DeviceCodeRow, userCode: string): PendingDeviceAuthorization {
	return {clientName: row.client_name ?? "A device", scopes: grantedScopes(row), userCode};
}

/** What the account holder is being asked to authorize. */
export async function lookupDeviceAuthorization(
	database: D1Database,
	userId: string,
	userCode: string,
	resource: string,
	now: number,
): Promise<DeviceAuthorizationLookup> {
	const claimed = await claimDeviceCode(database, userId, userCode, resource, now);
	return "row" in claimed
		? {status: "pending", authorization: pendingAuthorization(claimed.row, normalizeUserCode(userCode))}
		: claimed;
}

/**
 * Records the consent this grant will be listed and revoked by, then hands the code its decision.
 * Both writes go in one batch: a consent without an approved code authorizes nothing, and an
 * approved code without a consent would mint tokens Settings cannot see.
 */
export async function decideDeviceAuthorization(
	database: D1Database,
	userId: string,
	userCode: string,
	decision: DeviceAuthorizationDecision,
	resource: string,
	now: number,
): Promise<DeviceAuthorizationResult> {
	const claimed = await claimDeviceCode(database, userId, userCode, resource, now);
	if (!("row" in claimed)) {
		return claimed;
	}
	const {clientId, row} = claimed;
	const statements = [
		database
			.prepare("UPDATE device_code SET status = ?, user_id = ? WHERE id = ? AND status = 'pending'")
			.bind(decision, userId, row.id),
	];
	if (decision === "approved") {
		statements.unshift(
			database.prepare("DELETE FROM oauth_consent WHERE client_id = ? AND user_id = ?").bind(clientId, userId),
			database
				.prepare(
					"INSERT INTO oauth_consent " +
						"(id, client_id, user_id, resources, scopes, created_at, updated_at) " +
						"VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.bind(
					crypto.randomUUID(),
					clientId,
					userId,
					JSON.stringify(parseStoredStringArray(row.resources)),
					JSON.stringify(grantedScopes(row)),
					now,
					now,
				),
		);
	}
	const results = await database.batch(statements);
	const decided = results.at(-1);
	if (decided === undefined) {
		throw new Error("device authorization batch returned an incomplete result");
	}
	return decided.meta.changes === 1 ? {status: "decided", decision} : {status: "taken"};
}
