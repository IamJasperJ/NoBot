CREATE TABLE `sprites` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL,
	`outfit` text DEFAULT '' NOT NULL,
	`expression` text NOT NULL,
	`ext` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sprites_character_outfit_expression_idx` ON `sprites` (`character_id`,`outfit`,`expression`);