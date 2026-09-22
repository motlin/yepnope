import {drizzleAdapter} from "@better-auth/drizzle-adapter";
import {env} from "cloudflare:workers";
import {drizzle} from "drizzle-orm/d1";
import {describe, expect, it} from "vitest";
import {surfacingDriverMessages} from "../database-adapter";
import {users} from "../db/d1-schema";

function userAdapter() {
	const schema = {user: users};
	const factory = drizzleAdapter(drizzle(env.DB, {schema}), {provider: "sqlite", schema});
	return surfacingDriverMessages(factory)({});
}

async function insertUser(email: string): Promise<unknown> {
	return userAdapter().create({
		model: "user",
		data: {email, emailVerified: false, createdAt: new Date(), updatedAt: new Date()},
	});
}

describe("database adapter", () => {
	// 🏁 The OAuth provider seeds its resource row from both `init` and the first request, and treats
	// a UNIQUE failure on that insert as the other seeder winning. drizzle files the driver's
	// "UNIQUE constraint failed" under `cause`, so the plugin only recognises the collision when the
	// message it reads still names the constraint.
	it("names the violated constraint when an insert collides", async () => {
		const email = `${crypto.randomUUID()}@collision.example`;
		await insertUser(email);

		const failure = await insertUser(email).then(
			() => null,
			(caught: unknown) => (caught instanceof Error ? caught.message : String(caught)),
		);

		expect({
			rejected: failure !== null,
			namesConstraint: (failure ?? "").includes("UNIQUE constraint failed: user.email"),
		}).toStrictEqual({rejected: true, namesConstraint: true});
	});
});
