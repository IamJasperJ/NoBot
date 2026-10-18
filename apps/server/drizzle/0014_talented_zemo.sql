CREATE TABLE `lorebook_vectors` (
	`key` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`model` text NOT NULL,
	`vector` text NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `lorebook_entries`(`id`) ON UPDATE no action ON DELETE cascade
);
