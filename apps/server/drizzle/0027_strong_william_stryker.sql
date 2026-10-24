ALTER TABLE `channel_accounts` ADD `connection` text;--> statement-breakpoint
ALTER TABLE `channel_accounts` ADD `rate_limit` text DEFAULT '{"perMinute":20,"minIntervalMs":1200}' NOT NULL;--> statement-breakpoint
ALTER TABLE `channel_miniapp_tokens` ADD `actor_id` text;--> statement-breakpoint
ALTER TABLE `channel_miniapp_tokens` ADD `used_at` integer;--> statement-breakpoint
ALTER TABLE `channel_requests` ADD `flag` text;--> statement-breakpoint
ALTER TABLE `channel_requests` ADD `sub_type` text;--> statement-breakpoint
ALTER TABLE `channel_requests` ADD `expires_at` integer;