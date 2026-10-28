CREATE TABLE `channel_sticker_cooldowns` (
	`binding_id` text PRIMARY KEY NOT NULL,
	`last_sent_at` integer NOT NULL,
	`reply_count` integer NOT NULL,
	FOREIGN KEY (`binding_id`) REFERENCES `channel_bindings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `channel_sticker_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`source` text NOT NULL,
	`name` text NOT NULL,
	`title` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`characters` text DEFAULT '[]' NOT NULL,
	`fetched_at` integer,
	`attempted_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `channel_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_sticker_groups_source_idx` ON `channel_sticker_groups` (`account_id`,`source`,`name`);--> statement-breakpoint
CREATE TABLE `channel_stickers` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`group_id` text NOT NULL,
	`platform_key` text NOT NULL,
	`ref` text NOT NULL,
	`meanings` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`characters` text DEFAULT '[]' NOT NULL,
	`usage_count` integer DEFAULT 0 NOT NULL,
	`label_attempted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `channel_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `channel_sticker_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_stickers_platform_idx` ON `channel_stickers` (`account_id`,`platform_key`);