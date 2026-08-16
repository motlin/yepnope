import {and, eq, gt, lte} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {hashToken} from "./auth";
import {machineTokens, pairingCodes} from "./db/d1-schema";
import {PAIRING_CODE_TTL_MILLISECONDS} from "./validation";
import {base64UrlEncode} from "./webcrypto";

// 🤝 Pairing (spec §12): a six-character code with a ten minute expiry, stored in D1.

// No I, L, O, 0, or 1: the code gets read off a phone screen and typed into a terminal.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

function generatePairingCode(): string {
	const unbiasedLimit = 256 - (256 % CODE_ALPHABET.length);
	let code = "";
	while (code.length < CODE_LENGTH) {
		for (const byte of crypto.getRandomValues(new Uint8Array(CODE_LENGTH * 2))) {
			if (byte < unbiasedLimit && code.length < CODE_LENGTH) {
				code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
			}
		}
	}
	return code;
}

function mintToken(): string {
	return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export interface MintedIdentity {
	token: string;
	userId: string;
}

export async function createAppIdentity(database: D1Database): Promise<MintedIdentity> {
	const userId = crypto.randomUUID();
	const token = mintToken();
	await drizzle(database)
		.insert(machineTokens)
		.values({tokenHash: await hashToken(token), userId, label: "app", createdAt: Date.now()});
	return {token, userId};
}

export interface IssuedPairingCode {
	code: string;
	expiresAt: number;
}

export async function createPairingCode(database: D1Database, userId: string): Promise<IssuedPairingCode> {
	const db = drizzle(database);
	const now = Date.now();
	await db.delete(pairingCodes).where(lte(pairingCodes.expiresAt, now));
	const expiresAt = now + PAIRING_CODE_TTL_MILLISECONDS;
	for (;;) {
		const code = generatePairingCode();
		const inserted = await db
			.insert(pairingCodes)
			.values({code, userId, createdAt: now, expiresAt})
			.onConflictDoNothing()
			.returning({code: pairingCodes.code});
		if (inserted.length === 1) {
			return {code, expiresAt};
		}
	}
}

export async function claimPairingCode(
	database: D1Database,
	code: string,
	label: string,
): Promise<MintedIdentity | null> {
	const db = drizzle(database);
	// 🔒 Single-use: the DELETE consumes the code atomically, so a concurrent claim loses.
	const consumed = await db
		.delete(pairingCodes)
		.where(and(eq(pairingCodes.code, code), gt(pairingCodes.expiresAt, Date.now())))
		.returning({userId: pairingCodes.userId});
	const winner = consumed[0];
	if (winner === undefined) {
		return null;
	}
	const token = mintToken();
	await db
		.insert(machineTokens)
		.values({tokenHash: await hashToken(token), userId: winner.userId, label, createdAt: Date.now()});
	return {token, userId: winner.userId};
}
