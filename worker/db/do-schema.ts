import {integer, sqliteTable, text} from "drizzle-orm/sqlite-core";

// 🗄️ Per-user Durable Object SQLite schema (spec §4.2/§4.3).

export const state = sqliteTable("state", {
	id: integer("id").primaryKey(),
	afk: integer("afk", {mode: "boolean"}).notNull().default(true),
	questionsAsked: integer("questions_asked").notNull().default(0),
	yepCount: integer("yep_count").notNull().default(0),
	nopeCount: integer("nope_count").notNull().default(0),
	skipCount: integer("skip_count").notNull().default(0),
});

export const devices = sqliteTable("devices", {
	id: text("id").primaryKey(),
	pushSubscription: text("push_subscription").notNull(),
	createdAt: integer("created_at").notNull(),
});

export const batches = sqliteTable("batches", {
	id: text("id").primaryKey(),
	project: text("project").notNull(),
	createdAt: integer("created_at").notNull(),
	lastHeartbeatAt: integer("last_heartbeat_at").notNull(),
});

export const questions = sqliteTable("questions", {
	id: text("id").primaryKey(),
	batchId: text("batch_id")
		.notNull()
		.references(() => batches.id),
	position: integer("position").notNull(),
	title: text("title").notNull(),
	body: text("body").notNull(),
});

export const answers = sqliteTable("answers", {
	questionId: text("question_id")
		.primaryKey()
		.references(() => questions.id),
	disposition: text("disposition").notNull(),
	answeredAt: integer("answered_at").notNull(),
});
