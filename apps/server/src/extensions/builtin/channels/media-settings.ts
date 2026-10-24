import type { ExtensionSettingField } from '@nobot/shared'

export const mediaFields: ExtensionSettingField[] = [
  {
    key: 'voice',
    type: 'select',
    label: '渠道语音输出',
    options: [
      { value: 'off', label: '关闭' },
      { value: 'auto', label: '自动朗读' },
      { value: 'button', label: '朗读按钮' },
    ],
  },
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
