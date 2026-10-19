CREATE TABLE `audio_tracks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`kind` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`duration_ms` integer,
	`created_at` integer NOT NULL
);
