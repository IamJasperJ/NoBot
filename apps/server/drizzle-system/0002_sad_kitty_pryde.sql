CREATE TABLE `room_bans` (
	`room_id` text NOT NULL,
	`user_id` text NOT NULL,
	`by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`room_id`, `user_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `room_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`created_by` text NOT NULL,
	`kind` text NOT NULL,
	`target_user_id` text,
	`token_hash` text,
	`expires_at` integer NOT NULL,
	`max_uses` integer,
	`uses` integer DEFAULT 0 NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_invites_token_hash_unique` ON `room_invites` (`token_hash`);--> statement-breakpoint
CREATE TABLE `room_members` (
	`room_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`persona_name` text NOT NULL,
	`persona_description` text NOT NULL,
	`persona_avatar_file` text,
	`accepted_rules_version` integer NOT NULL,
	`joined_at` integer NOT NULL,
	`last_read_seq` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`room_id`, `user_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `room_members_user_idx` ON `room_members` (`user_id`,`state`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`host_user_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`cover_asset` text,
	`mode` text DEFAULT 'chat' NOT NULL,
	`turn_mode` text DEFAULT 'smart' NOT NULL,
	`content_rating` text DEFAULT 'general' NOT NULL,
	`content_notes` text DEFAULT '' NOT NULL,
	`rules` text DEFAULT '' NOT NULL,
	`rules_version` integer DEFAULT 1 NOT NULL,
	`max_members` integer DEFAULT 8 NOT NULL,
	`guest_quota` text DEFAULT '{"perHour":30,"perDay":300}' NOT NULL,
	`allow_member_invites` integer DEFAULT false NOT NULL,
	`allow_gm_kick` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`host_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_chat_id_unique` ON `rooms` (`chat_id`);--> statement-breakpoint
CREATE INDEX `rooms_host_idx` ON `rooms` (`host_user_id`);