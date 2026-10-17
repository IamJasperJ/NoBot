ALTER TABLE `play_presets` ADD `builtin_key` text;--> statement-breakpoint
-- 已有的内置预设按名字补上标识（改过名的匹配不到，就当作普通预设）
UPDATE `play_presets` SET `builtin_key` = CASE `name` WHEN '普通聊天' THEN 'chat' WHEN '陪伴' THEN 'companion' WHEN 'Galgame' THEN 'galgame' WHEN 'RPG' THEN 'rpg' WHEN 'D&D 5e' THEN 'dnd5e' END WHERE `builtin` = 1;
