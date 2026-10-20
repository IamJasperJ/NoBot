ALTER TABLE `profiles` ADD `image` text;
--> statement-breakpoint
UPDATE profiles SET image = json_object('source', 'openai', 'connectionId', image_connection_id, 'url', '', 'model', '', 'comfyWorkflow', NULL, 'style', '') WHERE image_connection_id IS NOT NULL;
