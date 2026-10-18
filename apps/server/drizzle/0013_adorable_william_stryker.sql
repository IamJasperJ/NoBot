CREATE TABLE `background_folder_items` (
	`folder_id` text NOT NULL,
	`background_id` text NOT NULL,
	PRIMARY KEY(`folder_id`, `background_id`),
	FOREIGN KEY (`folder_id`) REFERENCES `background_folders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`background_id`) REFERENCES `backgrounds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `background_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`cover_background_id` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`cover_background_id`) REFERENCES `backgrounds`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `characters` ADD `default_background_id` text REFERENCES backgrounds(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `chats` ADD `auto_background` text DEFAULT '{"lore":false,"everyN":0}' NOT NULL;--> statement-breakpoint
ALTER TABLE `groups` ADD `default_background_id` text REFERENCES backgrounds(id) ON DELETE set null;