CREATE TABLE `channel_registry` (
	`user_handle` text NOT NULL,
	`account_id` text NOT NULL,
	`provider` text NOT NULL,
	`receive_mode` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`user_handle`, `account_id`),
	FOREIGN KEY (`user_handle`) REFERENCES `users`(`handle`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `users` ADD `kind` text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `external_provider` text;--> statement-breakpoint
ALTER TABLE `users` ADD `external_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `external_owner_user_id` text REFERENCES users(id) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `users` ADD `avatar_file` text;--> statement-breakpoint
CREATE UNIQUE INDEX `external_user_identity_idx` ON `users` (`external_provider`,`external_owner_user_id`,`external_id`);