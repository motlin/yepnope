import {createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey} from "jose";
import {z} from "zod";
import {createObservationContext, observeEnvironment, observeHttpExchange} from "./observability";
import type {UserDurableObject} from "./user-do";

const objectIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
const objectDiagnosticsRequestSchema = z.object({object_ids: z.array(objectIdSchema).max(50)}).strict();
const objectDeletionRequestSchema = z.object({object_id: objectIdSchema}).strict();

export interface AdminEnvironment {
	ACCESS_AUD: string;
	ACCESS_TEAM_DOMAIN: string;
	DB: D1Database;
	USER_DO: DurableObjectNamespace<UserDurableObject>;
}

type AccessAuthenticator = (request: Request, environment: AdminEnvironment) => Promise<void>;

function accessIssuer(environment: AdminEnvironment): string {
	const url = new URL(environment.ACCESS_TEAM_DOMAIN);
	if (url.protocol !== "https:" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
		throw new Error("ACCESS_TEAM_DOMAIN must be an HTTPS origin");
	}
	return url.origin;
}

export async function authenticateAccessRequest(
	request: Request,
	environment: AdminEnvironment,
	keySet?: JWTVerifyGetKey,
): Promise<void> {
	const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
	if (assertion === null) {
		throw new Error("missing Cloudflare Access assertion");
	}
	const issuer = accessIssuer(environment);
	const verificationKey = keySet ?? createRemoteJWKSet(new URL("/cdn-cgi/access/certs", `${issuer}/`));
	await jwtVerify(assertion, verificationKey, {audience: environment.ACCESS_AUD, issuer});
}

async function listD1TableCounts(database: D1Database): Promise<Array<{name: string; rows: number}>> {
	const result = await database
		.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
		.all<{name: string}>();
	const tables = result.results.filter(({name}) => !name.startsWith("_cf_"));
	const counts: Array<{name: string; rows: number}> = [];
	for (const {name} of tables) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
			throw new Error("D1 contains an unsupported table name");
		}
		const row = await database.prepare(`SELECT count(*) AS rows FROM "${name}"`).first<{rows: number}>();
		if (row === null) {
			throw new Error(`D1 table count failed for ${name}`);
		}
		counts.push({name, rows: row.rows});
	}
	return counts;
}

async function listLiveOwnerObjectIds(environment: AdminEnvironment): Promise<string[]> {
	const result = await environment.DB.prepare('SELECT id FROM "user" ORDER BY id').all<{id: string}>();
	return result.results.map(({id}) => environment.USER_DO.idFromName(id).toString()).sort();
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("Cache-Control", "private, no-store");
	return Response.json(body, {...init, headers});
}

async function parseJson<T>(request: Request, schema: z.ZodType<T>): Promise<T | null> {
	const parsed = schema.safeParse(await request.json().catch(() => null));
	return parsed.success ? parsed.data : null;
}

export function createAdminHandler(authenticate: AccessAuthenticator = authenticateAccessRequest) {
	return {
		async fetch(request: Request, rawEnvironment: AdminEnvironment): Promise<Response> {
			const observationContext = createObservationContext("worker.admin");
			const environment = observeEnvironment(rawEnvironment, observationContext);
			return observeHttpExchange(observationContext, request, async (request) => {
				try {
					await authenticate(request, environment);
				} catch {
					return jsonResponse({error: "unauthorized"}, {status: 401});
				}

				const url = new URL(request.url);
				if (request.method === "GET" && url.pathname === "/v1/inventory-context") {
					const [tableCounts, liveOwnerObjectIds] = await Promise.all([
						listD1TableCounts(environment.DB),
						listLiveOwnerObjectIds(environment),
					]);
					return jsonResponse({d1: {table_counts: tableCounts}, live_owner_object_ids: liveOwnerObjectIds});
				}

				if (request.method === "POST" && url.pathname === "/v1/objects/diagnostics") {
					const body = await parseJson(request, objectDiagnosticsRequestSchema);
					if (body === null) {
						return jsonResponse({error: "invalid_request"}, {status: 400});
					}
					const objects = [];
					for (const objectId of body.object_ids) {
						const stub = environment.USER_DO.get(environment.USER_DO.idFromString(objectId));
						objects.push({object_id: objectId, ...(await stub.getRedactedStorageDiagnostics())});
					}
					return jsonResponse({objects});
				}

				if (request.method === "POST" && url.pathname === "/v1/objects/delete") {
					const body = await parseJson(request, objectDeletionRequestSchema);
					if (body === null) {
						return jsonResponse({error: "invalid_request"}, {status: 400});
					}
					const liveOwnerObjectIds = await listLiveOwnerObjectIds(environment);
					if (liveOwnerObjectIds.includes(body.object_id)) {
						return jsonResponse({error: "live_owner"}, {status: 409});
					}
					const stub = environment.USER_DO.get(environment.USER_DO.idFromString(body.object_id));
					await stub.deleteAll();
					return jsonResponse({object_id: body.object_id, status: "deleted"});
				}

				return jsonResponse({error: "not_found"}, {status: 404});
			});
		},
	};
}

export default createAdminHandler();
