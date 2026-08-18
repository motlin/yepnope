import application, {UserDurableObject} from "./index";
import {z} from "zod";

export {UserDurableObject};

interface CapturedEmail {
	subject: string;
	url: string;
}

type ApplicationEnvironment = Parameters<typeof application.fetch>[1];

const mailbox = new Map<string, CapturedEmail[]>();

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
			"(SELECT deleted_at IS NOT NULL FROM identity_lifecycles WHERE identity_id = ?) AS identity_deleted, " +
			"(SELECT completed_at IS NOT NULL FROM durable_object_cleanup_jobs WHERE object_name = ?) AS cleanup_completed",
	)
		.bind(parsed.data.user_id, parsed.data.user_id, parsed.data.user_id, parsed.data.user_id)
		.first();
	return Response.json(state);
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
		return application.fetch(request, withCapturedEmail(environment), executionContext);
	},
} satisfies ExportedHandler<ApplicationEnvironment>;
