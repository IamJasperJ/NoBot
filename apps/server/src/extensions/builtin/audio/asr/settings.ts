import type { ExtensionSettingField } from '@nobot/shared'
import { z } from 'zod'

export const asrSettings = z.object({
  asrEngine: z.enum(['off', 'openai-compatible']).catch('off'),
  asrBaseUrl: z.url().catch('https://api.openai.com/v1'),
  asrApiKey: z.string().catch(''),
  asrModel: z.string().trim().min(1).catch('whisper-1'),
  asrLanguage: z.enum(['auto', 'zh', 'en']).catch('auto'),
  asrPrompt: z.string().catch(''),
  asrMaxDuration: z.number().positive().max(3600).catch(120),
  asrMaxSizeMb: z.number().positive().max(25).catch(20),
})
export const asrFields: ExtensionSettingField[] = [
  { key: 'asr', type: 'heading', label: '语音识别', defaultCollapsed: true },
  {
    key: 'asrEngine',
    type: 'select',
    label: '识别引擎',
    options: [
      { value: 'off', label: '关闭' },
      { value: 'openai-compatible', label: 'OpenAI 兼容' },
    ],
  },
  { key: 'asrBaseUrl', type: 'string', label: '识别接口地址' },
  { key: 'asrApiKey', type: 'string', label: '识别 API 密钥', secret: true },
  { key: 'asrModel', type: 'string', label: '识别模型' },
  {
    key: 'asrLanguage',
    type: 'select',
    label: '识别语言',
    options: [
      { value: 'auto', label: '自动检测' },
      { value: 'zh', label: '中文' },
      { value: 'en', label: '英文' },
    ],
  },
  { key: 'asrPrompt', type: 'string', label: '识别提示词', hint: '用于识别的英文词汇或上下文提示' },
  { key: 'asrMaxDuration', type: 'number', label: '识别时长上限（秒）', min: 1, max: 3600 },
  { key: 'asrMaxSizeMb', type: 'number', label: '识别文件上限（MB）', min: 1, max: 25 },
]
