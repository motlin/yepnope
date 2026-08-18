PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_machine_tokens` (
	`id` text PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))) NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`label` text NOT NULL,
	`credential_type` text DEFAULT 'machine' NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_machine_tokens`("token_hash", "user_id", "label", "credential_type", "created_at", "last_used_at", "revoked_at") SELECT "token_hash", "user_id", "label", "credential_type", "created_at", "last_used_at", "revoked_at" FROM `machine_tokens`;--> statement-breakpoint
DROP TABLE `machine_tokens`;--> statement-breakpoint
ALTER TABLE `__new_machine_tokens` RENAME TO `machine_tokens`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `machine_tokens_token_hash_unique` ON `machine_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `machine_tokens_user_id_idx` ON `machine_tokens` (`user_id`);
