import {and, asc, count, eq, isNull, lte} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {hashToken} from "./auth";
import {machineTokens, pairingCodes} from "./db/d1-schema";
import type {UserDurableObject} from "./user-do";
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

export interface MintedMachineCredential {
	token: string;
	userId: string;
}

export interface IssuedPairingCode {
	code: string;
	expiresAt: number;
}

export interface PairedMachine {
	id: string;
	label: string;
	createdAt: number;
	lastUsedAt: number | null;
}

export async function listPairedMachines(database: D1Database, userId: string): Promise<PairedMachine[]> {
	return drizzle(database)
		.select({
			id: machineTokens.id,
			label: machineTokens.label,
			createdAt: machineTokens.createdAt,
			lastUsedAt: machineTokens.lastUsedAt,
		})
		.from(machineTokens)
		.where(
			and(
				eq(machineTokens.userId, userId),
				eq(machineTokens.credentialType, "machine"),
				isNull(machineTokens.revokedAt),
			),
		)
		.orderBy(asc(machineTokens.createdAt), asc(machineTokens.id));
}

export async function renameMachine(
	database: D1Database,
	userId: string,
	machineId: string,
	label: string,
): Promise<boolean> {
	const renamed = await drizzle(database)
		.update(machineTokens)
		.set({label})
		.where(
			and(
				eq(machineTokens.id, machineId),
				eq(machineTokens.userId, userId),
				eq(machineTokens.credentialType, "machine"),
				isNull(machineTokens.revokedAt),
			),
		)
		.returning({id: machineTokens.id});
	return renamed.length === 1;
}

export async function getPairedMachineCount(database: D1Database, userId: string): Promise<number> {
	const rows = await drizzle(database)
		.select({value: count()})
		.from(machineTokens)
		.where(
			and(
				eq(machineTokens.userId, userId),
				eq(machineTokens.credentialType, "machine"),
				isNull(machineTokens.revokedAt),
			),
		);
	return rows[0]?.value ?? 0;
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
): Promise<MintedMachineCredential | null> {
	const now = Date.now();
	const token = mintToken();
	const results = await database.batch<{user_id: string}>([
		database
			.prepare(
				"INSERT INTO machine_tokens " +
					"(token_hash, user_id, label, credential_type, created_at) " +
					"SELECT ?, user_id, ?, 'machine', ? FROM pairing_codes " +
					"WHERE code = ? AND expires_at > ? RETURNING user_id",
			)
			.bind(await hashToken(token), label, now, code, now),
		database.prepare("DELETE FROM pairing_codes WHERE code = ? AND expires_at > ?").bind(code, now),
	]);
	const winner = results[0]?.results[0];
	if (winner === undefined) {
		return null;
	}
	return {token, userId: winner.user_id};
}

export async function revokeMachineToken(
	database: D1Database,
	namespace: DurableObjectNamespace<UserDurableObject>,
	userId: string,
	machineId: string,
	revokedAt: number,
): Promise<boolean> {
	const revoked = await drizzle(database)
		.update(machineTokens)
		.set({revokedAt})
		.where(
			and(
				eq(machineTokens.id, machineId),
				eq(machineTokens.userId, userId),
				eq(machineTokens.credentialType, "machine"),
				isNull(machineTokens.revokedAt),
			),
		)
		.returning({id: machineTokens.id});
	if (revoked.length === 0) {
		return false;
	}
	const machineCount = await getPairedMachineCount(database, userId);
	await namespace.getByName(userId).synchronizePairingState(machineCount);
	return true;
}
