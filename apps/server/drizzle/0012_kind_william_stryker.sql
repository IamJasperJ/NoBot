CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`api_preset_id` text,
	`prompt_preset_id` text,
	`model` text DEFAULT '' NOT NULL,
	`regex_scripts` text,
	`image_connection_id` text,
	`prompt_connection_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`api_preset_id`) REFERENCES `api_presets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`prompt_preset_id`) REFERENCES `prompt_presets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`image_connection_id`) REFERENCES `api_presets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`prompt_connection_id`) REFERENCES `api_presets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `api_presets` ADD `vision` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `characters` ADD `profile_id` text REFERENCES profiles(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `profile_id` text REFERENCES profiles(id) ON DELETE SET NULL;