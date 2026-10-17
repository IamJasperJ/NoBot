// 旧默认值原文来自提交 4afedb5；玩法 schema 同时收录 b8c15e2 仅规则英文化后的版本。
// schema 保存为当时 JSON.stringify(schema, null, 2) 的完整结果，只允许逐字匹配。
export const LEGACY_MAIN_PROMPT =
  '你正在和{{user}}进行一场沉浸式角色扮演。你扮演{{char}}，只描写{{char}}的言行与内心，不要替{{user}}说话或做决定。保持人设一致，回复生动具体，推动情节发展。' as const

export const LEGACY_UTILITY_PROMPTS = {
  worldInfoFormat: '{0}',
  scenarioFormat: '{{scenario}}',
  personalityFormat: '{{personality}}',
  groupNudge: '[接下来只以{{char}}的身份写一条回复。]',
  newChat: '[开始新的对话]',
  newGroupChat: '[开始新的群聊。成员：{{group}}]',
  newExampleChat: '[示例对话]',
  continueNudge: '[接着写下面这条消息，不要重复原文，直接从断开的地方继续：{{lastChatMessage}}]',
  impersonation:
    '[以{{user}}的视角写下{{user}}的下一条回复，参考聊天记录里{{user}}的写作风格。不要以{{char}}或系统的身份写，不要描写{{char}}的行动。]',
  sendIfEmpty: '',
} as const

export const LEGACY_DIRECTIVE_TEMPLATES = {
  shorthand:
    '[舞台指令]\n这是一个视觉小说式的对话，界面会根据你写的舞台指令显示立绘、切换场景。请在正文中按下面的格式书写，指令会对读者隐藏：\n{{vn_kinds}}\n可登场的角色：{{vn_cast}}\n可用的表情：{{vn_expressions}}\n可用的背景：{{vn_backgrounds}}\n{{vn_state}}\n不要解释这些指令，也不要写成代码块。',
  xml: '[舞台指令]\n这是一个视觉小说式的对话，界面会根据你写的舞台指令显示立绘、切换场景。请全部使用下面的 XML 标签书写，指令会对读者隐藏：\n{{vn_kinds}}\n可登场的角色：{{vn_cast}}\n可用的表情：{{vn_expressions}}\n可用的背景：{{vn_backgrounds}}\n{{vn_state}}\n不要解释这些标签，也不要写成代码块。',
} as const

export const LEGACY_STATE_SCHEMAS = {
  galgame: [
    '{\n  "好感": {\n    "type": "meter",\n    "min": 0,\n    "max": 100,\n    "init": 30,\n    "label": "好感",\n    "stages": [\n      [\n        0,\n        "陌生"\n      ],\n      [\n        40,\n        "朋友"\n      ],\n      [\n        70,\n        "心动"\n      ],\n      [\n        90,\n        "恋人"\n      ]\n    ],\n    "rule": "温柔、体贴的互动 +1~3，冒犯或冷落 -3~5，重大事件可以更多"\n  },\n  "日期": {\n    "type": "text",\n    "init": "第1天",\n    "pin": true\n  },\n  "时间": {\n    "type": "text",\n    "init": "早晨",\n    "pin": true\n  },\n  "地点": {\n    "type": "text",\n    "init": ""\n  }\n}',
    '{\n  "好感": {\n    "type": "meter",\n    "min": 0,\n    "max": 100,\n    "init": 30,\n    "label": "好感",\n    "stages": [\n      [\n        0,\n        "陌生"\n      ],\n      [\n        40,\n        "朋友"\n      ],\n      [\n        70,\n        "心动"\n      ],\n      [\n        90,\n        "恋人"\n      ]\n    ],\n    "rule": "Kind, considerate interactions +1~3; offense or neglect -3~5; major events may change more"\n  },\n  "日期": {\n    "type": "text",\n    "init": "第1天",\n    "pin": true\n  },\n  "时间": {\n    "type": "text",\n    "init": "早晨",\n    "pin": true\n  },\n  "地点": {\n    "type": "text",\n    "init": ""\n  }\n}',
  ],
  rpg: [
    '{\n  "HP": {\n    "type": "meter",\n    "min": 0,\n    "max": "HP上限",\n    "init": 20,\n    "color": "red",\n    "pin": true,\n    "rule": "受伤时减少，休息或治疗时恢复"\n  },\n  "HP上限": {\n    "type": "number",\n    "init": 20\n  },\n  "金币": {\n    "type": "number",\n    "init": 10,\n    "pin": true\n  },\n  "背包": {\n    "type": "list",\n    "init": [\n      "短剑",\n      "火把×3",\n      "干粮×2"\n    ],\n    "rule": "获得或消耗物品时更新"\n  },\n  "任务": {\n    "type": "list",\n    "init": [],\n    "rule": "接受任务时加入，完成后移除"\n  },\n  "地点": {\n    "type": "text",\n    "init": "",\n    "pin": true\n  },\n  "时间": {\n    "type": "text",\n    "init": "第1天 早晨"\n  }\n}',
    '{\n  "HP": {\n    "type": "meter",\n    "min": 0,\n    "max": "HP上限",\n    "init": 20,\n    "color": "red",\n    "pin": true,\n    "rule": "Decrease when injured; recover through rest or healing"\n  },\n  "HP上限": {\n    "type": "number",\n    "init": 20\n  },\n  "金币": {\n    "type": "number",\n    "init": 10,\n    "pin": true\n  },\n  "背包": {\n    "type": "list",\n    "init": [\n      "短剑",\n      "火把×3",\n      "干粮×2"\n    ],\n    "rule": "Update when items are acquired or consumed"\n  },\n  "任务": {\n    "type": "list",\n    "init": [],\n    "rule": "Add accepted quests and remove completed ones"\n  },\n  "地点": {\n    "type": "text",\n    "init": "",\n    "pin": true\n  },\n  "时间": {\n    "type": "text",\n    "init": "第1天 早晨"\n  }\n}',
  ],
  dnd5e: [
    '{\n  "主角.等级": {\n    "type": "number",\n    "init": 1\n  },\n  "主角.HP": {\n    "type": "meter",\n    "min": 0,\n    "max": "主角.HP上限",\n    "init": 10,\n    "color": "red",\n    "pin": true,\n    "rule": "受到伤害时减少；短休 / 长休恢复"\n  },\n  "主角.HP上限": {\n    "type": "number",\n    "init": 10\n  },\n  "主角.AC": {\n    "type": "number",\n    "init": 12,\n    "pin": true\n  },\n  "主角.力量": {\n    "type": "number",\n    "init": 10\n  },\n  "主角.敏捷": {\n    "type": "number",\n    "init": 10\n  },\n  "主角.体质": {\n    "type": "number",\n    "init": 10\n  },\n  "主角.智力": {\n    "type": "number",\n    "init": 10\n  },\n  "主角.感知": {\n    "type": "number",\n    "init": 10\n  },\n  "主角.魅力": {\n    "type": "number",\n    "init": 10\n  },\n  "主角.熟练加值": {\n    "type": "number",\n    "init": 2\n  },\n  "主角.熟练技能": {\n    "type": "list",\n    "init": []\n  },\n  "主角.状态": {\n    "type": "list",\n    "init": [],\n    "rule": "中毒、倒地、魅惑等状态效果，解除时移除"\n  },\n  "背包": {\n    "type": "list",\n    "init": []\n  },\n  "金币": {\n    "type": "number",\n    "init": 0\n  },\n  "地点": {\n    "type": "text",\n    "init": "",\n    "pin": true\n  }\n}',
    '{\n  "主角.等级": {\n    "type": "number",\n    "init": 1\n  },\n  "主角.HP": {\n    "type": "meter",\n    "min": 0,\n    "max": "主角.HP上限",\n    "init": 10,\n    "color": "red",\n    "pin": true,\n    "rule": "Decrease when taking damage; recover during short or long rests"\n  },\n  "主角.HP上限": {\n    "type": "number",\n    "init": 10\n  },\n  "主角.AC": {\n    "type": "number",\n    "init": 12,\n    "pin": true\n  },\n  "主角.力量": {\n    "type": "number",\n    "init": 10\n  },\n  "主角.敏捷": {\n    "type": "number",\n    "init": 10\n  },\n  "主角.体质": {\n    "type": "number",\n    "init": 10\n  },\n  "主角.智力": {\n    "type": "number",\n    "init": 10\n  },\n  "主角.感知": {\n    "type": "number",\n    "init": 10\n  },\n  "主角.魅力": {\n    "type": "number",\n    "init": 10\n  },\n  "主角.熟练加值": {\n    "type": "number",\n    "init": 2\n  },\n  "主角.熟练技能": {\n    "type": "list",\n    "init": []\n  },\n  "主角.状态": {\n    "type": "list",\n    "init": [],\n    "rule": "Track conditions such as poisoned, prone, or charmed; remove when cleared"\n  },\n  "背包": {\n    "type": "list",\n    "init": []\n  },\n  "金币": {\n    "type": "number",\n    "init": 0\n  },\n  "地点": {\n    "type": "text",\n    "init": "",\n    "pin": true\n  }\n}',
  ],
} as const

export const LEGACY_EXTENSION_PROMPTS = {
  'image-gen': {
    tpl_character:
      '忽略之前的格式要求。请为 {{char}} 写一份用于 AI 绘图的外貌描述，按顺序包含：人数与性别（如 1girl / 1boy）、种族、年龄感、发型发色、眼睛、体型、服装、配饰、姿势、表情、背景简述。以 full body 开头。',
    tpl_face:
      '忽略之前的格式要求。请为 {{char}} 写一份脸部特写的 AI 绘图描述，按顺序包含：人数与性别、种族、年龄感、发型发色、眼睛、脸部特征、表情、头部配饰。以 close-up portrait, face focus 开头。',
    tpl_user:
      '忽略之前的格式要求。请为 {{user}}（用户扮演的角色）写一份用于 AI 绘图的外貌描述，按顺序包含：人数与性别、种族、年龄感、发型发色、眼睛、体型、服装、姿势、表情。以 full body 开头。如果设定里没有足够的外貌信息，就根据已有信息合理推断。',
    tpl_scene:
      '忽略之前的格式要求。请把当前故事正在发生的场景写成 AI 绘图描述：出场人物（数量、性别、外貌要点、动作）、地点、时间、光线、天气、氛围、镜头角度。',
    tpl_last:
      '忽略之前的格式要求。请把下面这段内容所描述的画面写成 AI 绘图描述（按位置、人物数量性别、相对位置、主要动作、外貌表情、动作的顺序，只描述一个静态画面）：\n{{input}}',
    tpl_message:
      '忽略之前的格式要求。请把下面这段内容所描述的画面写成 AI 绘图描述（按位置、人物数量性别、相对位置、主要动作、外貌表情、动作的顺序，只描述一个静态画面）：\n{{input}}',
    tpl_background:
      '忽略之前的格式要求。请为当前故事所在的地点写一份背景画面的 AI 绘图描述：只写环境（地点、建筑或自然景观、时间、光线、天气、氛围），画面里绝对不能出现任何人物。以 scenery, no humans 开头。',
    tpl_free: '忽略之前的格式要求。请把下面的画面描述扩写成 AI 绘图描述：\n{{input}}',
    messageTemplate: '[{{char}} 发送了一张图片：{{prompt}}]',
  },
  summary: {
    prompt:
      '你是故事记录员。根据【已有总结】和【新的对话】，写一份更新后的剧情总结：保留仍然重要的旧信息，加入新的事实、事件、人物关系变化和未解决的线索。用第三人称、过去时，按时间顺序，不写对话原文，不评论。不超过 {{words}} 字。只输出总结本身。',
    template: '[剧情总结：{{summary}}]',
  },
} as const
