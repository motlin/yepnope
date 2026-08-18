PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`afk` integer DEFAULT false NOT NULL,
	`questions_asked` integer DEFAULT 0 NOT NULL,
	`yep_count` integer DEFAULT 0 NOT NULL,
	`nope_count` integer DEFAULT 0 NOT NULL,
	`skip_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_state`("id", "afk", "questions_asked", "yep_count", "nope_count", "skip_count") SELECT "id", "afk", "questions_asked", "yep_count", "nope_count", "skip_count" FROM `state`;--> statement-breakpoint
DROP TABLE `state`;--> statement-breakpoint
ALTER TABLE `__new_state` RENAME TO `state`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
