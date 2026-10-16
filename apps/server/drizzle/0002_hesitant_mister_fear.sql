ALTER TABLE `backgrounds` ADD `mime` text DEFAULT 'image/webp' NOT NULL;--> statement-breakpoint
ALTER TABLE `characters` ADD `extensions` text DEFAULT '{}' NOT NULL;