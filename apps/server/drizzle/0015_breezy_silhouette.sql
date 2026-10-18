ALTER TABLE `api_presets` ADD `provider` text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE `api_presets` ADD `options` text DEFAULT '{}' NOT NULL;