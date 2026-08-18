CREATE TABLE `answers` (
	`question_id` text PRIMARY KEY NOT NULL,
	`disposition` text NOT NULL,
	`answered_at` integer NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `batches` (
	`id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`repo` text,
	`branch` text,
	`worktree` text,
	`directory` text,
	`created_at` integer NOT NULL,
	`last_heartbeat_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text DEFAULT 'Browser notifications' NOT NULL,
	`push_subscription` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `identity_merge_lock` (
	`id` integer PRIMARY KEY NOT NULL,
	`destination_user_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `identity_merges` (
	`source_user_id` text PRIMARY KEY NOT NULL,
	`imported_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `question_activity` (
	`question_id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`outcome` text NOT NULL,
	`created_at` integer NOT NULL,
	`outcome_at` integer
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `state` (
	`id` integer PRIMARY KEY NOT NULL,
	`afk` integer DEFAULT false NOT NULL
);
