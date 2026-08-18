CREATE TABLE `identity_merge_lock` (
	`id` integer PRIMARY KEY NOT NULL,
	`destination_user_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `identity_merges` (
	`source_user_id` text PRIMARY KEY NOT NULL,
	`imported_at` integer NOT NULL
);
