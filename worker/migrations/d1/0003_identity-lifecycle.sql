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
INSERT INTO `identity_lifecycles` (`identity_id`, `identity_type`, `owner_user_id`, `created_at`)
SELECT `user`.`id`, 'account', `user`.`id`, `user`.`created_at`
FROM `user`
WHERE EXISTS (SELECT 1 FROM `account` WHERE `account`.`user_id` = `user`.`id`);--> statement-breakpoint
INSERT INTO `identity_lifecycles` (`identity_id`, `identity_type`, `owner_user_id`, `created_at`, `expires_at`)
SELECT `machine_tokens`.`user_id`, 'legacy', NULL, min(`machine_tokens`.`created_at`),
	min(`machine_tokens`.`created_at`) + 2592000000
FROM `machine_tokens`
WHERE `machine_tokens`.`credential_type` = 'legacy_app'
	AND NOT EXISTS (SELECT 1 FROM `account` WHERE `account`.`user_id` = `machine_tokens`.`user_id`)
GROUP BY `machine_tokens`.`user_id`;
