import type { ExtensionSettingField } from '@nobot/shared'

export const oneBotFields: ExtensionSettingField[] = [
  {
    key: 'multiSpeaker',
    type: 'select',
    label: 'QQ 多角色消息',
    options: [
      { value: 'prefix', label: '名字前缀' },
      { value: 'forward', label: '合并转发' },
    ],
  },
  { key: 'controlsFooter', type: 'boolean', label: 'QQ 文字控制提示' },
  { key: 'groupCard', type: 'boolean', label: 'QQ 群名片跟随角色' },
  {
    key: 'onlineStatus',
    type: 'select',
    label: 'QQ 在线状态',
    options: [
      { value: 'off', label: '关闭' },
      { value: 'follow', label: '跟随生成与房间状态' },
    ],
  },
  { key: 'tempSessionDm', type: 'boolean', label: 'QQ 临时会话私信' },
  { key: 'pokeBack', type: 'boolean', label: 'QQ 戳一戳回应' },
  { key: 'pokeToStory', type: 'boolean', label: 'QQ 戳一戳进入剧情' },
  { key: 'dailySign', type: 'boolean', label: 'QQ 每日群签到' },
  { key: 'maxMessageLength', type: 'number', label: 'QQ 单条消息字符上限', min: 100, max: 4500 },
  { key: 'socialCooldownMs', type: 'number', label: 'QQ 轻互动冷却毫秒', min: 1000 },
  { key: 'socialDailyBudget', type: 'number', label: 'QQ 轻互动每日预算', min: 0, max: 1000 },
]
