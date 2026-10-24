ALTER TABLE `rooms` ADD `auto_resolve_when_ready` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `choice_mode` text DEFAULT 'gm' NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `vote_timeout_seconds` integer DEFAULT 60 NOT NULL;