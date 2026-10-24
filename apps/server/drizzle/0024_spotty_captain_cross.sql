CREATE TABLE `channel_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`name` text NOT NULL,
	`credentials` text NOT NULL,
	`base_url` text NOT NULL,
	`webhook_url` text,
	`receive_mode` text NOT NULL,
	`character_mode` text NOT NULL,
	`character_id` text,
	`group_id` text,
	`default_character_id` text,
	`persona_mode` text NOT NULL,
	`global_persona_id` text,
	`persona_locked` integer DEFAULT false NOT NULL,
	`presence` text NOT NULL,
	`policies` text NOT NULL,
	`settings` text NOT NULL,
	`status` text DEFAULT 'stopped' NOT NULL,
	`last_error` text,
	`cursor` integer,
	`bot_id` text,
	`bot_username` text,
	`bot_snapshot` text DEFAULT '{}' NOT NULL,
	`presence_sync` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `channel_actions` (
	`token` text PRIMARY KEY NOT NULL,
	`binding_id` text NOT NULL,
	`action` text NOT NULL,
	`args` text NOT NULL,
	`message_id` text,
	`revision` integer NOT NULL,
	`allowed_actor` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`binding_id`) REFERENCES `channel_bindings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `channel_actors` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`display_name` text NOT NULL,
	`username` text,
	`linked_user_id` text,
	`external_user_id` text,
	`role` text NOT NULL,
	`persona_id` text,
	`dm_chat_id` text,
	`persona_name` text,
	`persona_description` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_actors_identity_idx` ON `channel_actors` (`provider`,`external_id`);--> statement-breakpoint
CREATE TABLE `channel_binding_chats` (
	`binding_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`last_used_at` integer NOT NULL,
	PRIMARY KEY(`binding_id`, `chat_id`),
	FOREIGN KEY (`binding_id`) REFERENCES `channel_bindings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `channel_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`location_key` text NOT NULL,
	`scope` text NOT NULL,
	`chat` text NOT NULL,
	`thread` text DEFAULT '' NOT NULL,
	`actor` text DEFAULT '' NOT NULL,
	`isolation` text NOT NULL,
	`source` text NOT NULL,
	`chat_id` text NOT NULL,
	`room_id` text,
	`state` text NOT NULL,
	`speakers` text DEFAULT '{}' NOT NULL,
	`trigger` text NOT NULL,
	`persona_mode` text,
	`settings` text DEFAULT '{}' NOT NULL,
	`last_activity_at` integer NOT NULL,
	`idle_warned_at` integer,
	`created_by` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `channel_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_bindings_location_idx` ON `channel_bindings` (`account_id`,`location_key`);--> statement-breakpoint
CREATE TABLE `channel_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`binding_id` text NOT NULL,
	`message_id` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`parts` text NOT NULL,
	`status` text NOT NULL,
	`content_hash` text NOT NULL,
	FOREIGN KEY (`binding_id`) REFERENCES `channel_bindings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `channel_inbox` (
	`account_id` text NOT NULL,
	`external_event_id` text NOT NULL,
	`received_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `external_event_id`),
	FOREIGN KEY (`account_id`) REFERENCES `channel_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `channel_inbox_retention_idx` ON `channel_inbox` (`received_at`);--> statement-breakpoint
CREATE TABLE `channel_pairings` (
	`code` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`external_id` text NOT NULL,
	`display_name` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `channel_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `channel_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`chat` text NOT NULL,
	`title` text NOT NULL,
	`actor_external_id` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `channel_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `chats` ADD `source_provider` text;