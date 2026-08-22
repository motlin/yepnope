import {integer, sqliteTable, text} from "drizzle-orm/sqlite-core";

// 🗄️ Per-user Durable Object SQLite schema (spec §4.2/§4.3).
//
// 🔒 This schema has exactly one migration and always will: `worker/migrations/do/001_initial.sql`.
// `UserDurableObject.initialize()` refuses a bundle holding anything else, and a live object has
// already applied the baseline, so a changed baseline orphans every object that exists. Adding a
// table or a column here therefore means regenerating that one file and wiping every Durable
// Object in the same operation — see "Collapsing the migrations" in README.md.

export const state = sqliteTable("state", {
	id: integer("id").primaryKey(),
	afk: integer("afk", {mode: "boolean"}).notNull().default(false),
});

export const devices = sqliteTable("devices", {
	id: text("id").primaryKey(),
	label: text("label").notNull().default("Browser notifications"),
	pushSubscription: text("push_subscription").notNull(),
	createdAt: integer("created_at").notNull(),
});

export const batches = sqliteTable("batches", {
	id: text("id").primaryKey(),
	project: text("project").notNull(),
	// 🧭 Card chips (variant 2 in .llm/decisions.md): caller-derived, null for
	// hook-sourced and non-git batches.
	repo: text("repo"),
	branch: text("branch"),
	worktree: text("worktree"),
	directory: text("directory"),
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

export const questionActivity = sqliteTable("question_activity", {
	questionId: text("question_id").primaryKey(),
	batchId: text("batch_id").notNull(),
	outcome: text("outcome", {enum: ["outstanding", "yep", "nope", "skip", "retracted", "expired"]}).notNull(),
	createdAt: integer("created_at").notNull(),
	outcomeAt: integer("outcome_at"),
});
