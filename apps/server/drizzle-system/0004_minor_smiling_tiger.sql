CREATE TABLE `room_character_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`user_id` text NOT NULL,
	`source_character_id` text NOT NULL,
	`preview` text NOT NULL,
	`note` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`copy_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `room_notification_deliveries` (
	`key` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `room_session_rsvps` (
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`response` text NOT NULL,
	PRIMARY KEY(`session_id`, `user_id`),
	FOREIGN KEY (`session_id`) REFERENCES `room_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `room_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`title` text NOT NULL,
	`starts_at` integer NOT NULL,
	`duration_minutes` integer NOT NULL,
	`note` text NOT NULL,
	`created_by` text NOT NULL,
	`cancelled_at` integer,
	`reminded_at` integer,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `room_transfers` (
	`room_id` text PRIMARY KEY NOT NULL,
	`from_user_id` text NOT NULL,
	`to_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `room_invites` ADD `role` text DEFAULT 'player' NOT NULL;--> statement-breakpoint
ALTER TABLE `room_members` ADD `joined_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `room_members` ADD `notify_preference` text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `gm_approves_characters` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `allow_spectators` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `spectator_history` text DEFAULT 'since-join' NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `max_spectators` integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `async_mode` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `round_deadline_hours` integer;