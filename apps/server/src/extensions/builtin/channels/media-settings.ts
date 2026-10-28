import type { ExtensionSettingField } from '@nobot/shared'

export const mediaFields: ExtensionSettingField[] = [
  {
    key: 'stickerFrequency',
    type: 'select',
    label: '渠道贴纸频率',
    options: [
      { value: 'off', label: '关闭' },
      { value: 'rarely', label: '很少' },
      { value: 'sometimes', label: '有时' },
      { value: 'often', label: '经常' },
    ],
  },
  { key: 'stickerCooldownSec', type: 'number', label: '贴纸最短间隔秒数', min: 0, max: 86400 },
  { key: 'stickerAutoLearn', type: 'boolean', label: '自动学习渠道贴纸' },
  { key: 'stickerAutoLabel', type: 'boolean', label: '自动标注收藏表情' },
  { key: 'stickerMaxSets', type: 'number', label: '自动学习贴纸集上限', min: 0, max: 300 },
  {
    key: 'voice',
    type: 'select',
    label: '渠道语音输出',
    options: [
      { value: 'off', label: '关闭' },
      { value: 'auto', label: '自动朗读' },
      { value: 'button', label: '朗读按钮' },
      { value: 'only', label: '仅发送语音' },
      { value: 'decide', label: '让角色决定' },
    ],
  },
  {
    key: 'voiceDecideBias',
    type: 'select',
    label: '角色语音意愿',
    options: [
      { value: 'low', label: '低' },
      { value: 'medium', label: '中' },
      { value: 'high', label: '高' },
    ],
  },
  {
    key: 'voiceDecideStyle',
    type: 'select',
    label: '角色语音发送方式',
    options: [
      { value: 'only', label: '仅发送语音' },
      { value: 'with-text', label: '文字加语音' },
    ],
  },
  { key: 'voiceDecideHourlyMax', type: 'number', label: '角色语音每小时上限', hint: '0 表示不限次数', min: 0 },
  {
    key: 'voiceNarration',
    type: 'select',
    label: '纯语音旁白处理',
    options: [
      { value: 'speak', label: '朗读旁白' },
      { value: 'text', label: '旁白作为文字' },
      { value: 'drop', label: '省略旁白' },
    ],
  },
  {
    key: 'voiceLongText',
    type: 'select',
    label: '纯语音长文本处理',
    options: [
      { value: 'split', label: '分段朗读' },
      { value: 'text', label: '改发文字' },
    ],
  },
  { key: 'voiceMaxChars', type: 'number', label: '语音分段字符上限', min: 1, max: 4500 },
  { key: 'voiceInput', type: 'boolean', label: '渠道语音输入' },
  { key: 'echoTranscript', type: 'boolean', label: '回显识别文本', hint: '未覆盖时群聊开启，私聊关闭' },
  {
    key: 'sprites',
    type: 'select',
    label: '渠道立绘',
    options: [
      { value: 'off', label: '关闭' },
      { value: 'changes', label: '首次出场和表情变化' },
      { value: 'every', label: '每条消息' },
    ],
  },
  ...(
    [
      ['cg', '渠道 CG'],
      ['generatedImages', '渠道生图'],
    ] as const
  ).map(([key, label]) => ({
    key,
    label,
    type: 'select' as const,
    options: [
      { value: 'send', label: '发送图片' },
      { value: 'spoiler', label: '剧透图片' },
      { value: 'off', label: '关闭' },
    ],
  })),
  { key: 'background', type: 'boolean', label: '渠道背景图片' },
  {
    key: 'statusCard',
    type: 'select',
    label: '渠道状态卡',
    options: [
      { value: 'off', label: '关闭' },
      { value: 'every', label: '每条消息' },
      { value: 'pinned', label: '置顶并更新' },
    ],
  },
  { key: 'diceAnimation', type: 'boolean', label: '平台骰子装饰动画' },
]
