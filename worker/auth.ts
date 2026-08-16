import {eq} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {machineTokens} from "./db/d1-schema";

export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

// 🔑 Resolves the machine token to a user id, which names the per-user Durable Object.
export async function authenticateMachineToken(request: Request, database: D1Database): Promise<string | null> {
	const header = request.headers.get("Authorization");
	if (header === null || !header.startsWith("Bearer ")) {
		return null;
	}
	const tokenHash = await hashToken(header.slice("Bearer ".length));
	const rows = await drizzle(database)
		.select({userId: machineTokens.userId})
		.from(machineTokens)
		.where(eq(machineTokens.tokenHash, tokenHash));
	return rows[0]?.userId ?? null;
}
