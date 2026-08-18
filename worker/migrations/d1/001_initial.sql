CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_issuer_account_id_unique` ON `account` (`issuer`,`account_id`);--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `durable_object_cleanup_jobs` (
	`object_name` text PRIMARY KEY NOT NULL,
	`owner_user_id` text,
	`reason` text NOT NULL,
	`requested_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `durable_object_cleanup_jobs_completed_at_idx` ON `durable_object_cleanup_jobs` (`completed_at`);--> statement-breakpoint
CREATE TABLE `identity_lifecycles` (
	`identity_id` text PRIMARY KEY NOT NULL,
	`identity_type` text NOT NULL,
	`owner_user_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`claimed_at` integer,
	`deletion_requested_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `identity_lifecycles_owner_user_id_idx` ON `identity_lifecycles` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `identity_lifecycles_expires_at_idx` ON `identity_lifecycles` (`expires_at`);--> statement-breakpoint
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
CREATE TABLE `machine_tokens` (
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
CREATE UNIQUE INDEX `machine_tokens_token_hash_unique` ON `machine_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `machine_tokens_user_id_idx` ON `machine_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `pairing_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pairing_codes_user_id_idx` ON `pairing_codes` (`user_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);
