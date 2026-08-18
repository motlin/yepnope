CREATE TABLE `question_activity` (
	`question_id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`outcome` text NOT NULL,
	`created_at` integer NOT NULL,
	`outcome_at` integer
);
--> statement-breakpoint
INSERT INTO `question_activity` (`question_id`, `batch_id`, `outcome`, `created_at`, `outcome_at`)
SELECT
	`questions`.`id`,
	`questions`.`batch_id`,
	COALESCE(`answers`.`disposition`, 'outstanding'),
	`batches`.`created_at`,
	`answers`.`answered_at`
FROM `questions`
INNER JOIN `batches` ON `batches`.`id` = `questions`.`batch_id`
LEFT JOIN `answers` ON `answers`.`question_id` = `questions`.`id`;
--> statement-breakpoint
ALTER TABLE `state` DROP COLUMN `questions_asked`;--> statement-breakpoint
ALTER TABLE `state` DROP COLUMN `yep_count`;--> statement-breakpoint
ALTER TABLE `state` DROP COLUMN `nope_count`;--> statement-breakpoint
ALTER TABLE `state` DROP COLUMN `skip_count`;
