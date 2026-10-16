CREATE TABLE `api_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`api_key` text DEFAULT '' NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `character_lorebooks` (
	`character_id` text NOT NULL,
	`lorebook_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`character_id`, `lorebook_id`),
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lorebook_id`) REFERENCES `lorebooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `characters` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`personality` text DEFAULT '' NOT NULL,
	`scenario` text DEFAULT '' NOT NULL,
	`first_mes` text DEFAULT '' NOT NULL,
	`alternate_greetings` text DEFAULT '[]' NOT NULL,
	`mes_example` text DEFAULT '' NOT NULL,
	`system_prompt` text DEFAULT '' NOT NULL,
	`post_history_instructions` text DEFAULT '' NOT NULL,
	`creator_notes` text DEFAULT '' NOT NULL,
	`creator` text DEFAULT '' NOT NULL,
	`character_version` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`talkativeness` real DEFAULT 0.5 NOT NULL,
	`character_note` text DEFAULT '' NOT NULL,
	`character_note_depth` integer DEFAULT 4 NOT NULL,
	`character_note_role` text DEFAULT 'system' NOT NULL,
	`default_persona_id` text,
	`avatar_file` text,
	`raw` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chat_lorebooks` (
	`chat_id` text NOT NULL,
	`lorebook_id` text NOT NULL,
	PRIMARY KEY(`chat_id`, `lorebook_id`),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lorebook_id`) REFERENCES `lorebooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text,
	`group_id` text,
	`persona_id` text,
	`title` text NOT NULL,
	`active_leaf_id` text,
	`api_preset_id` text,
	`prompt_preset_id` text,
	`author_note` text DEFAULT '' NOT NULL,
	`author_note_depth` integer DEFAULT 4 NOT NULL,
	`author_note_role` text DEFAULT 'system' NOT NULL,
	`vars` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`api_preset_id`) REFERENCES `api_presets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`prompt_preset_id`) REFERENCES `prompt_presets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `chats_character_idx` ON `chats` (`character_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `chats_group_idx` ON `chats` (`group_id`);--> statement-breakpoint
CREATE TABLE `generation_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text,
	`message_id` text,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`model` text,
	`duration_ms` integer,
	`summary` text DEFAULT '' NOT NULL,
	`request` text,
	`response` text,
	`report` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `generation_logs_created_idx` ON `generation_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `group_members` (
	`group_id` text NOT NULL,
	`character_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`muted` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`group_id`, `character_id`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`activation` text DEFAULT 'natural' NOT NULL,
	`generation_mode` text DEFAULT 'swap' NOT NULL,
	`allow_self_responses` integer DEFAULT false NOT NULL,
	`auto_mode` integer DEFAULT false NOT NULL,
	`scenario_override` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lorebook_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`lorebook_id` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`lorebook_id`) REFERENCES `lorebooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lorebook_entries_book_idx` ON `lorebook_entries` (`lorebook_id`,`sort`);--> statement-breakpoint
CREATE TABLE `lorebooks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`is_global` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`parent_id` text,
	`role` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'done' NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`speaker_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_chat_parent_idx` ON `messages` (`chat_id`,`parent_id`);--> statement-breakpoint
CREATE TABLE `personas` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`avatar_file` text,
	`lorebook_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`lorebook_id`) REFERENCES `lorebooks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `prompt_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
