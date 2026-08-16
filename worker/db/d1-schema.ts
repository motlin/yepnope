import {integer, sqliteTable, text} from "drizzle-orm/sqlite-core";

// 🗄️ D1 schema: everything the Worker must resolve before it knows which DO to address (spec §4.3).

export const machineTokens = sqliteTable("machine_tokens", {
	tokenHash: text("token_hash").primaryKey(),
	userId: text("user_id").notNull(),
	label: text("label"),
	createdAt: integer("created_at").notNull(),
});

export const pairingCodes = sqliteTable("pairing_codes", {
	code: text("code").primaryKey(),
	userId: text("user_id").notNull(),
	createdAt: integer("created_at").notNull(),
	expiresAt: integer("expires_at").notNull(),
});
