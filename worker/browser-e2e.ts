import application, {UserDurableObject} from "./index";
import {OAUTH_SCOPES} from "./auth";
import {getConnectedMcpClientAuthorizationState} from "./connected-mcp-clients";
import {z} from "zod";

export {UserDurableObject};

interface CapturedEmail {
	subject: string;
	url: string;
}

type ApplicationEnvironment = Parameters<typeof application.fetch>[1];

const mailbox = new Map<string, CapturedEmail[]>();
const OBSERVATION_CAPTURE_LIMIT = 4_096;
const observationLines: string[] = [];
let droppedObservationLineCount = 0;

function captureObservationLine(...values: unknown[]): void {
	for (const value of values) {
		if (typeof value !== "string") {
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(value);
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				!("schema" in parsed) ||
				parsed.schema !== "yepnope.io.v1"
			) {
				continue;
			}
		} catch {
			continue;
		}
		if (observationLines.length === OBSERVATION_CAPTURE_LIMIT) {
			observationLines.shift();
			droppedObservationLineCount += 1;
		}
		observationLines.push(value);
	}
}

console.log = captureObservationLine;
console.error = captureObservationLine;

async function captureAuthenticationEmail(message: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> {
	if (!("text" in message)) {
		throw new Error("browser test authentication email is missing its text body");
	}
	if (!("to" in message) || typeof message.to !== "string") {
		throw new Error("browser test authentication email must have one string recipient");
	}
	const url = /https:\/\/\S+/.exec(message.text)?.[0];
	if (url === undefined) {
		throw new Error("browser test authentication email is missing its link");
	}
	const deliveries = mailbox.get(message.to) ?? [];
	deliveries.push({subject: message.subject, url});
	mailbox.set(message.to, deliveries);
	return Promise.resolve({messageId: crypto.randomUUID()});
}

const email: SendEmail = {send: captureAuthenticationEmail};

function withCapturedEmail(environment: ApplicationEnvironment): ApplicationEnvironment {
	return {
		AUTH_EMAIL_FROM: environment.AUTH_EMAIL_FROM,
		BETTER_AUTH_SECRET: environment.BETTER_AUTH_SECRET,
		BETTER_AUTH_URL: environment.BETTER_AUTH_URL,
		DB: environment.DB,
		EMAIL: email,
		USER_DO: environment.USER_DO,
		VAPID_PRIVATE_JWK: environment.VAPID_PRIVATE_JWK,
		VAPID_SUBJECT: environment.VAPID_SUBJECT,
	};
}

function mailboxResponse(url: URL): Response {
	const recipient = url.searchParams.get("email");
	const subject = url.searchParams.get("subject");
	if (recipient === null || subject === null) {
		return new Response(null, {status: 400});
	}
	const delivery = mailbox
		.get(recipient)
		?.filter((candidate) => candidate.subject === subject)
		.at(-1);
	return delivery === undefined ? new Response(null, {status: 404}) : Response.json({url: delivery.url});
}

async function countResponse(environment: ApplicationEnvironment): Promise<Response> {
	const counts = await environment.DB.prepare(
		"SELECT (SELECT count(*) FROM user) AS users, " +
			"(SELECT count(*) FROM machine_tokens) AS machine_tokens, " +
			"(SELECT count(*) FROM pairing_codes) AS pairing_codes",
	).first();
	return Response.json({authentication_url: environment.BETTER_AUTH_URL, ...counts});
}

async function deletedAccountResponse(request: Request, environment: ApplicationEnvironment): Promise<Response> {
	const parsed = z.object({user_id: z.string()}).safeParse(await request.json());
	if (!parsed.success) {
		return new Response(null, {status: 400});
	}
	const state = await environment.DB.prepare(
		"SELECT " +
			"(SELECT count(*) FROM user WHERE id = ?) AS users, " +
			"(SELECT count(*) FROM machine_tokens WHERE user_id = ?) AS machine_tokens, " +
			"(SELECT count(*) FROM oauth_client WHERE user_id = ?) AS oauth_clients, " +
			"(SELECT deleted_at IS NOT NULL FROM identity_lifecycles WHERE identity_id = ?) AS identity_deleted, " +
			"(SELECT completed_at IS NOT NULL FROM durable_object_cleanup_jobs WHERE object_name = ?) AS cleanup_completed",
	)
		.bind(parsed.data.user_id, parsed.data.user_id, parsed.data.user_id, parsed.data.user_id, parsed.data.user_id)
		.first();
	return Response.json(state);
}

async function authorizeMcpClientResponse(request: Request, environment: ApplicationEnvironment): Promise<Response> {
	const parsed = z.object({user_id: z.string()}).safeParse(await request.json());
	if (!parsed.success) {
		return new Response(null, {status: 400});
	}
	const createdAt = Date.now();
	const installationId = crypto.randomUUID();
	const clientId = `browser-e2e-oauth-client-${installationId}`;
	const resources = JSON.stringify([`${environment.BETTER_AUTH_URL}/mcp`]);
	const scopes = JSON.stringify([...OAUTH_SCOPES]);
	await environment.DB.batch([
		environment.DB.prepare(
			"INSERT INTO oauth_client (id, client_id, user_id, created_at, updated_at, name, redirect_uris) " +
				"VALUES (?, ?, ?, ?, ?, 'Browser test MCP client', ?)",
		).bind(
			`browser-e2e-oauth-client-row-${installationId}`,
			clientId,
			parsed.data.user_id,
			createdAt,
			createdAt,
			JSON.stringify([`http://127.0.0.1/callback/${installationId}`]),
		),
		environment.DB.prepare(
			"INSERT INTO oauth_consent (id, client_id, user_id, resources, scopes, created_at, updated_at) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?)",
		).bind(
			`browser-e2e-oauth-consent-${installationId}`,
			clientId,
			parsed.data.user_id,
			resources,
			scopes,
			createdAt,
			createdAt,
		),
		environment.DB.prepare(
			"INSERT INTO oauth_refresh_token " +
				"(id, token, client_id, user_id, resources, expires_at, created_at, scopes) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).bind(
			`browser-e2e-oauth-refresh-${installationId}`,
			`browser-e2e-refresh-token-${installationId}`,
			clientId,
			parsed.data.user_id,
			resources,
			Date.UTC(2099, 0, 1),
			createdAt,
			scopes,
		),
	]);
	const authorizationState = await getConnectedMcpClientAuthorizationState(
		environment.DB,
		parsed.data.user_id,
		`${environment.BETTER_AUTH_URL}/mcp`,
	);
	await environment.USER_DO.getByName(parsed.data.user_id).synchronizeConnectedMcpClientAuthorizationState(
		authorizationState,
	);
	return Response.json({status: "authorized"});
}

const observationAuditSchema = z.object({forbidden_values: z.array(z.string().min(1).max(8_192)).max(64)}).strict();

async function observationAuditResponse(request: Request): Promise<Response> {
	const parsed = observationAuditSchema.safeParse(await request.json());
	if (!parsed.success) {
		return new Response(null, {status: 400});
	}
	const captured = observationLines.join("\n");
	const forbiddenValueIndices = parsed.data.forbidden_values.flatMap((value, index) =>
		captured.includes(value) ? [index] : [],
	);
	const forbiddenValueOperations = parsed.data.forbidden_values.flatMap((value, index) => {
		const operations = observationLines.flatMap((line) => {
			if (!line.includes(value)) {
				return [];
			}
			const observation: unknown = JSON.parse(line);
			if (typeof observation !== "object" || observation === null || !("operation" in observation)) {
				return [];
			}
			return typeof observation.operation === "string" ? [observation.operation] : [];
		});
		return operations.length === 0 ? [] : [{index, operations: [...new Set(operations)]}];
	});
	return Response.json({
		dropped_event_count: droppedObservationLineCount,
		event_count: observationLines.length,
		forbidden_value_detected: forbiddenValueIndices.length > 0,
		forbidden_value_indices: forbiddenValueIndices,
		forbidden_value_operations: forbiddenValueOperations,
		maximum_line_bytes: Math.max(0, ...observationLines.map((line) => new TextEncoder().encode(line).byteLength)),
		mcp_exchange_event_count: observationLines.filter((line) => line.includes("/mcp")).length,
		oauth_exchange_event_count: observationLines.filter((line) => line.includes("/api/auth/")).length,
		redacted_body_event_count: observationLines.filter((line) => line.includes('"redacted"')).length,
	});
}

function resetObservationCapture(): Response {
	observationLines.length = 0;
	droppedObservationLineCount = 0;
	return Response.json({status: "reset"});
}

export default {
	async fetch(request, environment, executionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/api/__e2e__/mailbox" && request.method === "GET") {
			return mailboxResponse(url);
		}
		if (url.pathname === "/api/__e2e__/counts" && request.method === "GET") {
			return countResponse(environment);
		}
		if (url.pathname === "/api/__e2e__/deleted-account" && request.method === "POST") {
			return deletedAccountResponse(request, environment);
		}
		if (url.pathname === "/api/__e2e__/authorize-mcp-client" && request.method === "POST") {
			return authorizeMcpClientResponse(request, environment);
		}
		if (url.pathname === "/api/__e2e__/observations" && request.method === "POST") {
			return observationAuditResponse(request);
		}
		if (url.pathname === "/api/__e2e__/observations" && request.method === "DELETE") {
			return resetObservationCapture();
		}
		return application.fetch(request, withCapturedEmail(environment), executionContext);
	},
} satisfies ExportedHandler<ApplicationEnvironment>;
