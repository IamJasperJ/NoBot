PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`api_preset_id` text,
	`prompt_preset_id` text,
	`model` text DEFAULT '' NOT NULL,
	`regex_scripts` text,
	`image` text,
	`prompt_connection_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`api_preset_id`) REFERENCES `api_presets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`prompt_preset_id`) REFERENCES `prompt_presets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`prompt_connection_id`) REFERENCES `api_presets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_profiles`("id", "name", "api_preset_id", "prompt_preset_id", "model", "regex_scripts", "image", "prompt_connection_id", "created_at", "updated_at") SELECT "id", "name", "api_preset_id", "prompt_preset_id", "model", "regex_scripts", "image", "prompt_connection_id", "created_at", "updated_at" FROM `profiles`;--> statement-breakpoint
-- 迁移事务中关闭外键不会生效；重建表前保存绑定，避免 ON DELETE SET NULL 清空它们。
CREATE TEMP TABLE `__profile_character_bindings` AS SELECT id, profile_id FROM characters WHERE profile_id IS NOT NULL;
--> statement-breakpoint
CREATE TEMP TABLE `__profile_chat_bindings` AS SELECT id, profile_id FROM chats WHERE profile_id IS NOT NULL;
--> statement-breakpoint
DROP TABLE `profiles`;--> statement-breakpoint
ALTER TABLE `__new_profiles` RENAME TO `profiles`;--> statement-breakpoint
UPDATE characters SET profile_id = (SELECT profile_id FROM __profile_character_bindings WHERE id = characters.id) WHERE id IN (SELECT id FROM __profile_character_bindings);
--> statement-breakpoint
UPDATE chats SET profile_id = (SELECT profile_id FROM __profile_chat_bindings WHERE id = chats.id) WHERE id IN (SELECT id FROM __profile_chat_bindings);
--> statement-breakpoint
DROP TABLE __profile_character_bindings;
--> statement-breakpoint
DROP TABLE __profile_chat_bindings;
--> statement-breakpoint
PRAGMA foreign_keys=ON;