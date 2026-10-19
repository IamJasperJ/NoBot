-- 只迁移 JSON 对象的扩展键，不替换用户文本中的字样；旧键覆盖同名新键，避免旧角色设置丢失。
-- 原始角色卡、全局设置和两类预设也可能携带扩展对象，递归处理各层以及数组中的对象。
WITH RECURSIVE renamed(row_key, doc) AS (
  SELECT id, extensions FROM characters WHERE json_valid(extensions)
  UNION ALL
  SELECT renamed.row_key,
    json_remove(
      json_set(renamed.doc,
        parent.fullkey || CASE node.key WHEN 'ai_parter' THEN '.nobot' ELSE '.nobot_vn' END,
        json(renamed.doc -> node.fullkey)),
      node.fullkey)
  FROM renamed, json_tree(renamed.doc) AS node, json_tree(renamed.doc) AS parent
  WHERE node.key IN ('ai_parter', 'ai_parter_vn')
    AND parent.id = node.parent AND parent.type = 'object'
    AND node.id = (SELECT min(id) FROM json_tree(renamed.doc) WHERE key IN ('ai_parter', 'ai_parter_vn'))
)
UPDATE characters SET extensions = (
  SELECT doc FROM renamed WHERE row_key = characters.id
    AND NOT EXISTS (SELECT 1 FROM json_tree(doc) WHERE key IN ('ai_parter', 'ai_parter_vn'))
)
WHERE json_valid(extensions) AND EXISTS (
  SELECT 1 FROM json_tree(characters.extensions) WHERE key IN ('ai_parter', 'ai_parter_vn')
);
--> statement-breakpoint
WITH RECURSIVE renamed(row_key, doc) AS (
  SELECT id, raw FROM characters WHERE json_valid(raw)
  UNION ALL
  SELECT renamed.row_key,
    json_remove(
      json_set(renamed.doc,
        parent.fullkey || CASE node.key WHEN 'ai_parter' THEN '.nobot' ELSE '.nobot_vn' END,
        json(renamed.doc -> node.fullkey)),
      node.fullkey)
  FROM renamed, json_tree(renamed.doc) AS node, json_tree(renamed.doc) AS parent
  WHERE node.key IN ('ai_parter', 'ai_parter_vn')
    AND parent.id = node.parent AND parent.type = 'object'
    AND node.id = (SELECT min(id) FROM json_tree(renamed.doc) WHERE key IN ('ai_parter', 'ai_parter_vn'))
)
UPDATE characters SET raw = (
  SELECT doc FROM renamed WHERE row_key = characters.id
    AND NOT EXISTS (SELECT 1 FROM json_tree(doc) WHERE key IN ('ai_parter', 'ai_parter_vn'))
)
WHERE json_valid(raw) AND EXISTS (
  SELECT 1 FROM json_tree(characters.raw) WHERE key IN ('ai_parter', 'ai_parter_vn')
);
--> statement-breakpoint
WITH RECURSIVE renamed(row_key, doc) AS (
  SELECT key, value FROM settings WHERE json_valid(value)
  UNION ALL
  SELECT renamed.row_key,
    json_remove(
      json_set(renamed.doc,
        parent.fullkey || CASE node.key WHEN 'ai_parter' THEN '.nobot' ELSE '.nobot_vn' END,
        json(renamed.doc -> node.fullkey)),
      node.fullkey)
  FROM renamed, json_tree(renamed.doc) AS node, json_tree(renamed.doc) AS parent
  WHERE node.key IN ('ai_parter', 'ai_parter_vn')
    AND parent.id = node.parent AND parent.type = 'object'
    AND node.id = (SELECT min(id) FROM json_tree(renamed.doc) WHERE key IN ('ai_parter', 'ai_parter_vn'))
)
UPDATE settings SET value = (
  SELECT doc FROM renamed WHERE row_key = settings.key
    AND NOT EXISTS (SELECT 1 FROM json_tree(doc) WHERE key IN ('ai_parter', 'ai_parter_vn'))
)
WHERE json_valid(value) AND EXISTS (
  SELECT 1 FROM json_tree(settings.value) WHERE key IN ('ai_parter', 'ai_parter_vn')
);
--> statement-breakpoint
WITH RECURSIVE renamed(row_key, doc) AS (
  SELECT id, data FROM play_presets WHERE json_valid(data)
  UNION ALL
  SELECT renamed.row_key,
    json_remove(
      json_set(renamed.doc,
        parent.fullkey || CASE node.key WHEN 'ai_parter' THEN '.nobot' ELSE '.nobot_vn' END,
        json(renamed.doc -> node.fullkey)),
      node.fullkey)
  FROM renamed, json_tree(renamed.doc) AS node, json_tree(renamed.doc) AS parent
  WHERE node.key IN ('ai_parter', 'ai_parter_vn')
    AND parent.id = node.parent AND parent.type = 'object'
    AND node.id = (SELECT min(id) FROM json_tree(renamed.doc) WHERE key IN ('ai_parter', 'ai_parter_vn'))
)
UPDATE play_presets SET data = (
  SELECT doc FROM renamed WHERE row_key = play_presets.id
    AND NOT EXISTS (SELECT 1 FROM json_tree(doc) WHERE key IN ('ai_parter', 'ai_parter_vn'))
)
WHERE json_valid(data) AND EXISTS (
  SELECT 1 FROM json_tree(play_presets.data) WHERE key IN ('ai_parter', 'ai_parter_vn')
);
--> statement-breakpoint
WITH RECURSIVE renamed(row_key, doc) AS (
  SELECT id, data FROM prompt_presets WHERE json_valid(data)
  UNION ALL
  SELECT renamed.row_key,
    json_remove(
      json_set(renamed.doc,
        parent.fullkey || CASE node.key WHEN 'ai_parter' THEN '.nobot' ELSE '.nobot_vn' END,
        json(renamed.doc -> node.fullkey)),
      node.fullkey)
  FROM renamed, json_tree(renamed.doc) AS node, json_tree(renamed.doc) AS parent
  WHERE node.key IN ('ai_parter', 'ai_parter_vn')
    AND parent.id = node.parent AND parent.type = 'object'
    AND node.id = (SELECT min(id) FROM json_tree(renamed.doc) WHERE key IN ('ai_parter', 'ai_parter_vn'))
)
UPDATE prompt_presets SET data = (
  SELECT doc FROM renamed WHERE row_key = prompt_presets.id
    AND NOT EXISTS (SELECT 1 FROM json_tree(doc) WHERE key IN ('ai_parter', 'ai_parter_vn'))
)
WHERE json_valid(data) AND EXISTS (
  SELECT 1 FROM json_tree(prompt_presets.data) WHERE key IN ('ai_parter', 'ai_parter_vn')
);
