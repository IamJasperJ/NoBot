CREATE TABLE `play_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `chats` ADD `play_preset_id` text;