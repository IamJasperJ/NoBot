CREATE TABLE `channel_actor_locations` (
	`actor_id` text NOT NULL,
	`account_id` text NOT NULL,
	`chat` text NOT NULL,
	`thread` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`actor_id`, `account_id`, `chat`, `thread`),
	FOREIGN KEY (`actor_id`) REFERENCES `channel_actors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `channel_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `channel_actors` ADD `account_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `channel_actors` ADD `last_seen_at` integer;--> statement-breakpoint
ALTER TABLE `channel_bindings` ADD `title` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `channel_bindings` ADD `topic_title` text;--> statement-breakpoint
ALTER TABLE `channel_requests` ADD `actor_name` text;