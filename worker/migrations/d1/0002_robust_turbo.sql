CREATE TABLE `legacy_identity_claims` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`legacy_user_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`claimed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_identity_claims_legacy_user_id_unique` ON `legacy_identity_claims` (`legacy_user_id`);--> statement-breakpoint
CREATE INDEX `legacy_identity_claims_user_id_idx` ON `legacy_identity_claims` (`user_id`);--> statement-breakpoint
ALTER TABLE `machine_tokens` ADD `credential_type` text DEFAULT 'machine' NOT NULL;--> statement-breakpoint
UPDATE `machine_tokens` SET `credential_type` = 'legacy_app' WHERE `label` = 'app';
