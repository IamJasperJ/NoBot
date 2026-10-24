CREATE TABLE `room_events` (
	`room_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`actor_id` text NOT NULL,
	`entity_id` text,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`room_id`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `room_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`tokens` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `room_usage_room_time_idx` ON `room_usage` (`room_id`,`created_at`);