ALTER TABLE `sprites` ADD `updated_at` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `sprites` SET `updated_at` = `created_at`;
