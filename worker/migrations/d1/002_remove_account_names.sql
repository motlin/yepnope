PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
-- Better Auth 1.7 requires the nullable compatibility column, but YepNope erases every existing value.
INSERT INTO `__new_user`("id", "name", "email", "email_verified", "image", "created_at", "updated_at") SELECT "id", NULL, "email", "email_verified", "image", "created_at", "updated_at" FROM `user`;--> statement-breakpoint
-- D1 applies migrations transactionally, so PRAGMA foreign_keys cannot disable cascades during this rebuild.
CREATE TABLE `__backup_account` AS SELECT * FROM `account`;--> statement-breakpoint
CREATE TABLE `__backup_legacy_identity_claims` AS SELECT * FROM `legacy_identity_claims`;--> statement-breakpoint
CREATE TABLE `__backup_machine_tokens` AS SELECT * FROM `machine_tokens`;--> statement-breakpoint
CREATE TABLE `__backup_pairing_codes` AS SELECT * FROM `pairing_codes`;--> statement-breakpoint
CREATE TABLE `__backup_session` AS SELECT * FROM `session`;--> statement-breakpoint
DELETE FROM `account`;--> statement-breakpoint
DELETE FROM `legacy_identity_claims`;--> statement-breakpoint
DELETE FROM `machine_tokens`;--> statement-breakpoint
DELETE FROM `pairing_codes`;--> statement-breakpoint
DELETE FROM `session`;--> statement-breakpoint
DROP TABLE `user`;--> statement-breakpoint
ALTER TABLE `__new_user` RENAME TO `user`;--> statement-breakpoint
INSERT INTO `account` SELECT * FROM `__backup_account`;--> statement-breakpoint
INSERT INTO `legacy_identity_claims` SELECT * FROM `__backup_legacy_identity_claims`;--> statement-breakpoint
INSERT INTO `machine_tokens` SELECT * FROM `__backup_machine_tokens`;--> statement-breakpoint
INSERT INTO `pairing_codes` SELECT * FROM `__backup_pairing_codes`;--> statement-breakpoint
INSERT INTO `session` SELECT * FROM `__backup_session`;--> statement-breakpoint
DROP TABLE `__backup_account`;--> statement-breakpoint
DROP TABLE `__backup_legacy_identity_claims`;--> statement-breakpoint
DROP TABLE `__backup_machine_tokens`;--> statement-breakpoint
DROP TABLE `__backup_pairing_codes`;--> statement-breakpoint
DROP TABLE `__backup_session`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);
