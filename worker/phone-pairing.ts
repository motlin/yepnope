import {createAuthEndpoint, sessionMiddleware} from "better-auth/api";
import {setSessionCookie} from "better-auth/cookies";
import {z} from "zod";
import {hashToken} from "./webcrypto";

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTWXYZ";
const EXPIRY_MILLISECONDS = 10 * 60 * 1_000;

export function generatePairingCode(): string {
	let code = "";
	const maximum = 256 - (256 % CODE_ALPHABET.length);
	while (code.length < 8) {
		const bytes = crypto.getRandomValues(new Uint8Array(16));
		for (const byte of bytes) {
			if (byte < maximum && code.length < 8) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
		}
	}
	return code;
}

export function normalizePairingCode(code: string): string | null {
	const normalized = code.replaceAll(/[\s-]/g, "").toUpperCase();
	return /^[23456789ABCDEFGHJKMNPQRSTWXYZ]{8}$/.test(normalized) ? normalized : null;
}

export async function createPhonePairing(database: D1Database, sessionId: string, now: number) {
	const id = crypto.randomUUID();
	const code = generatePairingCode();
	const expiresAt = now + EXPIRY_MILLISECONDS;
	await database.batch([
		database.prepare("DELETE FROM phone_pairing WHERE session_id = ? OR expires_at <= ?").bind(sessionId, now),
		database
			.prepare("INSERT INTO phone_pairing (id, session_id, code_hash, expires_at) VALUES (?, ?, ?, ?)")
			.bind(id, sessionId, await hashToken(code), expiresAt),
	]);
	return {id, code, expiresAt};
}

/** Atomic consumption keeps concurrent scanners from creating two browser sessions. */
export async function consumePhonePairing(
	database: D1Database,
	id: string,
	code: string,
	now: number,
): Promise<string | null> {
	const codeHash = await hashToken(normalizePairingCode(code) ?? "invalid");
	const results = await database.batch([
		database
			.prepare("UPDATE phone_pairing SET attempts = attempts + 1 WHERE id = ? AND code_hash != ?")
			.bind(id, codeHash),
		database.prepare("DELETE FROM phone_pairing WHERE id = ? AND (attempts >= 5 OR expires_at <= ?)").bind(id, now),
		database
			.prepare(
				"DELETE FROM phone_pairing WHERE id = ? AND code_hash = ? AND expires_at > ? AND attempts < 5 " +
					"AND session_id IN (SELECT session.id FROM session JOIN user ON user.id = session.user_id WHERE session.expires_at > ? AND user.email_verified = 1) " +
					"RETURNING (SELECT user_id FROM session WHERE session.id = phone_pairing.session_id) AS user_id",
			)
			.bind(id, codeHash, now, now),
	]);
	const consumed = results[2]?.results[0];
	return consumed === undefined ? null : z.object({user_id: z.string()}).parse(consumed).user_id;
}

/** RFC 8628 grants agent scopes; it must never be exchangeable for an account's browser session. */
export function phonePairing(database: D1Database, origin: string) {
	return {
		id: "phone-pairing",
		rateLimit: [{pathMatcher: (path: string) => path.startsWith("/phone-pairing/"), window: 60, max: 10}],
		endpoints: {
			createPhonePairing: createAuthEndpoint(
				"/phone-pairing/create",
				{method: "POST", use: [sessionMiddleware]},
				async (context) => {
					if (
						context.request?.headers.get("Origin") !== origin ||
						!context.context.session.user.emailVerified
					) {
						throw context.error("FORBIDDEN", {message: "A verified desktop session is required."});
					}
					context.setHeader("Cache-Control", "no-store");
					return context.json(
						await createPhonePairing(database, context.context.session.session.id, Date.now()),
					);
				},
			),
			claimPhonePairing: createAuthEndpoint(
				"/phone-pairing/claim",
				{
					method: "POST",
					body: z.object({id: z.uuid(), code: z.string().max(64)}).strict(),
				},
				async (context) => {
					if (context.request?.headers.get("Origin") !== origin) {
						throw context.error("FORBIDDEN", {message: "Open YepNope to pair this phone."});
					}
					context.setHeader("Cache-Control", "no-store");
					const userId = await consumePhonePairing(database, context.body.id, context.body.code, Date.now());
					if (userId === null)
						throw context.error("BAD_REQUEST", {
							message: "This code is invalid or expired. Create a new QR code on your desktop.",
						});
					const user = await context.context.internalAdapter.findUserById(userId);
					if (user === null || !user.emailVerified)
						throw context.error("FORBIDDEN", {message: "A verified account is required."});
					const session = await context.context.internalAdapter.createSession(userId);
					await setSessionCookie(context, {session, user});
					return context.json({status: "ok"});
				},
			),
		},
	};
}
