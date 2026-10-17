ALTER TABLE `bookmarks` ADD `kind` text DEFAULT 'bookmark' NOT NULL;--> statement-breakpoint
ALTER TABLE `bookmarks` ADD `snapshot` text;