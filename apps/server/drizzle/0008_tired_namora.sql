ALTER TABLE `backgrounds` ADD `description` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `backgrounds` ADD `chat_id` text REFERENCES chats(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `background_pinned` integer DEFAULT false NOT NULL;