import { type PlayPresetData, playPresetDataSchema, type StateSchema } from '@ai-parter/shared'
import { db, getSetting, newId, setSetting } from '../db/client'
import { playPresets } from '../db/schema'
import { t } from '../i18n'
import { SETTING_KEYS } from './settings'

function galgame(): StateSchema {
  return {
    affection: {
      label: t('好感'),
      pin: true,
      type: 'meter',
      min: 0,
      max: 100,
      init: 30,
      stages: [
        [0, 'Strangers'],
        [40, 'Friends'],
        [70, 'Attraction'],
        [90, 'Lovers'],
      ],
      rule: 'Kind, considerate interactions +1~3; offense or neglect -3~5; major events may change more',
    },
    day: { label: t('日期'), type: 'text', init: 'Day 1', pin: true },
    time: { label: t('时间'), type: 'text', init: 'Morning', pin: true },
    location: { label: t('地点'), type: 'text', init: '' },
  }
}
function rpg(): StateSchema {
  return {
    hp: {
      label: t('生命值'),
      type: 'meter',
      min: 0,
      max: 'maxHp',
      init: 20,
      color: 'red',
      pin: true,
      rule: 'Decrease when injured; recover through rest or healing',
    },
    maxHp: { label: t('生命上限'), type: 'number', init: 20 },
    gold: { label: t('金币'), type: 'number', init: 10, pin: true },
    inventory: {
      label: t('背包'),
      type: 'list',
      init: ['Short sword', 'Torch x3', 'Rations x2'],
      rule: 'Update when items are acquired or consumed',
    },
    quests: { label: t('任务'), type: 'list', init: [], rule: 'Add accepted quests and remove completed ones' },
    location: { label: t('地点'), type: 'text', init: '', pin: true },
    time: { label: t('时间'), type: 'text', init: 'Day 1 morning' },
  }
}
function dnd(): StateSchema {
  return {
    'player.level': { label: t('等级'), type: 'number', init: 1 },
    'player.hp': {
      label: t('生命值'),
      type: 'meter',
      min: 0,
      max: 'player.maxHp',
      init: 10,
      color: 'red',
      pin: true,
      rule: 'Decrease when taking damage; recover during short or long rests',
    },
    'player.maxHp': { label: t('生命上限'), type: 'number', init: 10 },
    'player.ac': { label: t('护甲等级'), type: 'number', init: 12, pin: true },
    ...Object.fromEntries(
      [
        ['str', t('力量')],
        ['dex', t('敏捷')],
        ['con', t('体质')],
        ['int', t('智力')],
        ['wis', t('感知')],
        ['cha', t('魅力')],
      ].map(([name, label]) => [`player.${name}`, { type: 'number' as const, init: 10, label }]),
    ),
    'player.proficiencyBonus': { label: t('熟练加值'), type: 'number', init: 2 },
    'player.skills': { label: t('熟练技能'), type: 'list', init: [] },
    'player.conditions': {
      label: t('状态'),
      type: 'list',
      init: [],
      rule: 'Track conditions such as poisoned, prone, or charmed; remove when cleared',
    },
    inventory: { label: t('背包'), type: 'list', init: [] },
    gold: { label: t('金币'), type: 'number', init: 0 },
    location: { label: t('地点'), type: 'text', init: '', pin: true },
  }
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
      data.interaction.hud = false
      return data
    },
  },
  {
    key: 'galgame',
    name: 'Galgame',
    build: () => {
      const data = story(['expression', 'cast', 'scene', 'state', 'choices', 'cg'], 'adv', galgame())
      data.interaction.stageLore = true
      return data
    },
  },
  {
    key: 'rpg',
    name: 'RPG',
    build: () => {
      const data = story(['expression', 'cast', 'scene', 'state', 'choices'], 'auto', rpg())
      data.interaction.choiceLayout = 'column'
      return data
    },
  },
  {
    key: 'dnd5e',
    name: 'D&D 5e',
    build: () => {
      const data = story(['expression', 'cast', 'scene', 'state', 'choices', 'combat'], 'auto', dnd())
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
