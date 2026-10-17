import { type PlayPresetData, playPresetDataSchema, type StateSchema } from '@ai-parter/shared'
import { db, getSetting, newId, setSetting } from '../db/client'
import { playPresets } from '../db/schema'
import { SETTING_KEYS } from './settings'

const galgame: StateSchema = {
  好感: {
    type: 'meter',
    min: 0,
    max: 100,
    init: 30,
    label: '好感',
    stages: [
      [0, '陌生'],
      [40, '朋友'],
      [70, '心动'],
      [90, '恋人'],
    ],
    rule: '温柔、体贴的互动 +1~3，冒犯或冷落 -3~5，重大事件可以更多',
  },
  日期: { type: 'text', init: '第1天', pin: true },
  时间: { type: 'text', init: '早晨', pin: true },
  地点: { type: 'text', init: '' },
}
const rpg: StateSchema = {
  HP: { type: 'meter', min: 0, max: 'HP上限', init: 20, color: 'red', pin: true, rule: '受伤时减少，休息或治疗时恢复' },
  HP上限: { type: 'number', init: 20 },
  金币: { type: 'number', init: 10, pin: true },
  背包: { type: 'list', init: ['短剑', '火把×3', '干粮×2'], rule: '获得或消耗物品时更新' },
  任务: { type: 'list', init: [], rule: '接受任务时加入，完成后移除' },
  地点: { type: 'text', init: '', pin: true },
  时间: { type: 'text', init: '第1天 早晨' },
}
const dnd: StateSchema = {
  '主角.等级': { type: 'number', init: 1 },
  '主角.HP': {
    type: 'meter',
    min: 0,
    max: '主角.HP上限',
    init: 10,
    color: 'red',
    pin: true,
    rule: '受到伤害时减少；短休 / 长休恢复',
  },
  '主角.HP上限': { type: 'number', init: 10 },
  '主角.AC': { type: 'number', init: 12, pin: true },
  ...Object.fromEntries(
    ['力量', '敏捷', '体质', '智力', '感知', '魅力'].map((name) => [
      `主角.${name}`,
      { type: 'number' as const, init: 10 },
    ]),
  ),
  '主角.熟练加值': { type: 'number', init: 2 },
  '主角.熟练技能': { type: 'list', init: [] },
  '主角.状态': { type: 'list', init: [], rule: '中毒、倒地、魅惑等状态效果，解除时移除' },
  背包: { type: 'list', init: [] },
  金币: { type: 'number', init: 0 },
  地点: { type: 'text', init: '', pin: true },
}

export type BuiltinPlayPresetKey = 'chat' | 'companion' | 'galgame' | 'rpg' | 'dnd5e'

/** 内置玩法预设的定义。「重置为内置默认」和「补回内置预设」都按这里重新生成 */
export const BUILTIN_PLAY_PRESETS: { key: BuiltinPlayPresetKey; name: string; build: () => PlayPresetData }[] = [
  { key: 'chat', name: '普通聊天', build: () => playPresetDataSchema.parse({}) },
  {
    key: 'companion',
    name: '陪伴',
    build: () => {
      const data = playPresetDataSchema.parse({})
      data.directives.enabled = true
      data.directives.kinds = ['expression', 'cast']
      data.directives.lists = ['cast', 'expressions']
      return data
    },
  },
  {
    key: 'galgame',
    name: 'Galgame',
    build: () => story(['expression', 'cast', 'scene', 'state', 'choices', 'cg'], 'adv', galgame),
  },
  { key: 'rpg', name: 'RPG', build: () => story(['expression', 'cast', 'scene', 'state', 'choices'], 'auto', rpg) },
  {
    key: 'dnd5e',
    name: 'D&D 5e',
    build: () => {
      const data = story(['expression', 'cast', 'scene', 'state', 'choices', 'combat'], 'auto', dnd)
      data.trpg.ruleSystem = 'dnd5e'
      return data
    },
  },
]

/** 剧情类预设（Galgame / RPG / 跑团）的共同部分：开指令、默认进 VN 视图、带状态定义 */
function story(kinds: PlayPresetData['directives']['kinds'], layout: 'adv' | 'auto', schema: StateSchema) {
  const data = playPresetDataSchema.parse({})
  data.directives.enabled = true
  data.directives.kinds = kinds
  data.basic.openInVn = true
  data.basic.layout = layout
  data.state.schema = JSON.stringify(schema, null, 2)
  return data
}

function insertBuiltin(def: (typeof BUILTIN_PLAY_PRESETS)[number]) {
  const id = newId()
  const now = Date.now()
  db.insert(playPresets)
    .values({ id, name: def.name, data: def.build(), builtinKey: def.key, createdAt: now, updatedAt: now })
    .run()
  return id
}

/** 只记录首次播种，用户主动删除的内置预设不会在重启后恢复（可以在设置里手动「补回内置预设」）。 */
export function seedPlayPresets() {
  if (getSetting(SETTING_KEYS.playPresetsSeeded) === true) return
  db.transaction(() => {
    for (const def of BUILTIN_PLAY_PRESETS) {
      const id = insertBuiltin(def)
      if (def.key === 'chat') setSetting(SETTING_KEYS.defaultPlayPresetId, id)
    }
    setSetting(SETTING_KEYS.playPresetsSeeded, true)
  })
}

/** 补回被删掉的内置预设，返回补回了几个 */
export function restoreBuiltinPlayPresets(): number {
  const existing = new Set(
    db
      .select({ key: playPresets.builtinKey })
      .from(playPresets)
      .all()
      .map((row) => row.key),
  )
  const missing = BUILTIN_PLAY_PRESETS.filter((def) => !existing.has(def.key))
  db.transaction(() => {
    for (const def of missing) insertBuiltin(def)
  })
  return missing.length
}

/** 把内置预设的名字和全部设置恢复成内置默认；不是内置预设时返回 null */
export function builtinDefinition(key: string | null) {
  return BUILTIN_PLAY_PRESETS.find((def) => def.key === key) ?? null
}
