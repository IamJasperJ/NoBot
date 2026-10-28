PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_channel_actions` (
	`token` text PRIMARY KEY NOT NULL,
	`binding_id` text,
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
INSERT INTO `__new_channel_actions`("token", "binding_id", "action", "args", "message_id", "revision", "allowed_actor", "expires_at", "used_at") SELECT "token", "binding_id", "action", "args", "message_id", "revision", "allowed_actor", "expires_at", "used_at" FROM `channel_actions`;--> statement-breakpoint
DROP TABLE `channel_actions`;--> statement-breakpoint
ALTER TABLE `__new_channel_actions` RENAME TO `channel_actions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `channel_accounts` ADD `character_allowlist` text DEFAULT '[]' NOT NULL;