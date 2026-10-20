import { createHash } from 'node:crypto'
import { type ExtensionSettingField, voiceRefSchema } from '@nobot/shared'
import { z } from 'zod'

// 设置页里刚选了引擎、还没选声音的条目（voice 为空）先存着，解析时当作没设置
const voiceSetting = voiceRefSchema.nullable().catch(null)
const voiceListSetting = z
  .array(z.unknown())
  .default([])
  .transform((items) =>
    items.flatMap((item) => {
      const parsed = voiceRefSchema.safeParse(item)
      return parsed.success ? [parsed.data] : []
    }),
  )

export const audioSettings = z.object({
  listInPrompt: z.boolean().default(true),
  ttsEnabled: z.boolean().default(false),
  narratorVoice: voiceSetting.default(null),
  readNarration: z.boolean().default(false),
  userVoice: voiceSetting.default(null),
  readUser: z.boolean().default(false),
  npcVoices: voiceListSetting,
  autoRead: z.boolean().default(false),
  vnVoice: z.boolean().default(true),
  vnWaitVoice: z.boolean().default(true),
  vnInterrupt: z.boolean().default(true),
  expressionStyle: z.boolean().default(true),
  edgeVolume: z.number().int().min(-100).max(100).default(0),
  cacheMaxMb: z.number().finite().nonnegative().default(500),
  openaiConnectionId: z.string().default(''),
  openaiBaseUrl: z.string().default('https://api.openai.com/v1'),
  openaiApiKey: z.string().default(''),
  openaiModel: z.string().default('gpt-4o-mini-tts'),
  gptsovitsEndpoint: z.string().default('http://127.0.0.1:9880'),
  gptsovitsVoices: z
    .array(
      z
        .object({
          id: z.string().default(''),
          name: z.string().default(''),
          refAudioPath: z.string().default(''),
          promptText: z.string().default(''),
          promptLang: z
            .string()
            .default('zh')
            .transform((value) => value || 'zh'),
          textLang: z
            .string()
            .default('auto')
            .transform((value) => value || 'auto'),
        })
        .transform((preset) => ({
          ...preset,
          id:
            preset.id ||
            createHash('sha256')
              .update(JSON.stringify([preset.name, preset.refAudioPath]))
              .digest('hex')
              .slice(0, 16),
        })),
    )
    .default([]),
  elevenlabsApiKey: z.string().default(''),
  elevenlabsModel: z.string().default('eleven_multilingual_v2'),
})
export type AudioSettings = z.infer<typeof audioSettings>
export const ttsFields: ExtensionSettingField[] = [
  { key: 'tts', type: 'heading', label: '朗读设置' },
  ...(
    [
      ['ttsEnabled', '开启朗读'],
      ['readNarration', '朗读旁白'],
      ['readUser', '朗读用户台词'],
      ['autoRead', '自动朗读新回复'],
      ['vnVoice', 'VN 逐句朗读'],
      ['vnWaitVoice', 'VN 自动播放等待语音'],
      ['vnInterrupt', '切句时打断语音'],
      ['expressionStyle', '用表情控制语气'],
    ] as const
  ).map(([key, label]) => ({ key, label, type: 'boolean' as const })),
  { key: 'narratorVoice', type: 'custom', label: '旁白声音' },
  { key: 'userVoice', type: 'custom', label: '用户声音' },
  { key: 'npcVoices', type: 'custom', label: 'NPC 声音池' },
  { key: 'cacheMaxMb', type: 'number', label: '语音缓存上限（MB）', min: 0 },
  { key: 'openai', type: 'heading', label: 'OpenAI 兼容语音', defaultCollapsed: true },
  {
    key: 'openaiConnectionId',
    type: 'select',
    label: '语音连接',
    options: [{ value: '', label: '单独配置' }],
    optionsSource: 'tts/connections',
  },
  {
    key: 'openaiBaseUrl',
    type: 'string',
    label: '语音接口地址',
    visibleWhen: { key: 'openaiConnectionId', equals: '' },
  },
  {
    key: 'openaiApiKey',
    type: 'string',
    label: '语音接口密钥',
    secret: true,
    visibleWhen: { key: 'openaiConnectionId', equals: '' },
  },
  { key: 'openaiModel', type: 'string', label: '语音模型' },
  { key: 'gptsovits', type: 'heading', label: 'GPT-SoVITS 语音', defaultCollapsed: true },
  { key: 'gptsovitsEndpoint', type: 'string', label: 'GPT-SoVITS 地址' },
  {
    key: 'gptsovitsVoices',
    type: 'list',
    label: '参考声音预设',
    titleKey: 'name',
    itemFields: [
      { key: 'id', type: 'string', label: '声音标识' },
      { key: 'name', type: 'string', label: '声音名称' },
      { key: 'refAudioPath', type: 'string', label: '参考音频路径' },
      { key: 'promptText', type: 'textarea', label: '参考音频文字' },
      { key: 'promptLang', type: 'string', label: '参考音频语言' },
      { key: 'textLang', type: 'string', label: '合成文本语言' },
    ],
  },
  {
    key: 'edge',
    type: 'heading',
    label: 'Edge 语音',
    hint: 'Edge 使用非官方接口，可能随时失效',
    defaultCollapsed: true,
  },
  { key: 'edgeVolume', type: 'number', label: 'Edge 默认音量（%）', min: -100, max: 100 },
  { key: 'elevenlabs', type: 'heading', label: 'ElevenLabs 语音', defaultCollapsed: true },
  { key: 'elevenlabsApiKey', type: 'string', label: 'ElevenLabs 密钥', secret: true },
  { key: 'elevenlabsModel', type: 'string', label: 'ElevenLabs 模型' },
]
