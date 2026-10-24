CREATE TABLE `channel_managed_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`manager_account_id` text NOT NULL,
	`character_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`manager_account_id`) REFERENCES `channel_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `channel_miniapp_replays` (
	`hash` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `channel_miniapp_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`binding_id` text,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `channel_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`binding_id`) REFERENCES `channel_bindings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `channel_accounts` ADD `managed_by` text;