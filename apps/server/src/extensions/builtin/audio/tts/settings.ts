import { createHash } from 'node:crypto'
import { TONES } from '@nobot/core'
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
  chatBgm: z.boolean().default(true),
  autoBgm: z.boolean().default(false),
  autoBgmEvery: z.number().int().min(1).default(5),
  autoBgmConnectionId: z.string().default(''),
  autoBgmModel: z.string().default(''),
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
          emotionRefs: z
            .array(z.object({ tone: z.enum(TONES), refAudioPath: z.string(), promptText: z.string().default('') }))
            .default([]),
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
  minimaxCustomVoices: z.array(z.object({ id: z.string(), name: z.string().default('') })).default([]),
  volcengineCustomVoices: z.array(z.object({ id: z.string(), name: z.string().default('') })).default([]),
  minimaxApiKey: z.string().default(''),
  minimaxApiHost: z.string().default('https://api.minimaxi.com'),
  minimaxModel: z.string().default('speech-02-hd'),
  volcengineAppId: z.string().default(''),
  volcengineAccessKey: z.string().default(''),
  volcengineResourceId: z.string().default('seed-tts-2.0'),
  volcengineEndpoint: z.string().default('https://openspeech.bytedance.com/api/v3/tts/unidirectional'),
  cosyvoiceEndpoint: z.string().default('http://127.0.0.1:50000'),
  cosyvoiceSampleRate: z.number().int().min(1).default(22050),
  cosyvoiceVoices: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        mode: z.enum(['sft', 'instruct', 'zero_shot']).default('sft'),
        spkId: z.string().default(''),
        promptText: z.string().default(''),
        refTrackId: z.string().default(''),
      }),
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
  { key: 'npcVoices', type: 'custom', label: 'NPC 声音池', hint: '为空时，没设声音的角色和 NPC 用旁白声音' },
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
      {
        key: 'emotionRefs',
        type: 'list',
        label: '语气参考音频',
        titleKey: 'tone',
        itemFields: [
          { key: 'tone', type: 'select', label: '语气', options: TONES.map((value) => ({ value, label: value })) },
          { key: 'refAudioPath', type: 'string', label: '参考音频路径' },
          { key: 'promptText', type: 'textarea', label: '参考音频文字' },
        ],
      },
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

export const chatBgmFields: ExtensionSettingField[] = [
  { key: 'chatBgm', type: 'boolean', label: '普通聊天播放背景音乐' },
  { key: 'autoBgm', type: 'boolean', label: '自动选择背景音乐' },
  { key: 'autoBgmEvery', type: 'number', label: '每几条回复选择音乐', min: 1 },
  {
    key: 'autoBgmConnectionId',
    type: 'select',
    label: '音乐选择连接',
    options: [{ value: '', label: '跟随会话' }],
    optionsSource: 'bgm/connections',
  },
  { key: 'autoBgmModel', type: 'string', label: '音乐选择模型', hint: '留空跟随会话' },
]
ttsFields.push(
  { key: 'minimax', type: 'heading', label: 'MiniMax 语音', defaultCollapsed: true },
  { key: 'minimaxApiKey', type: 'string', label: 'MiniMax 密钥', secret: true },
  {
    key: 'minimaxApiHost',
    type: 'select',
    label: 'MiniMax 接口',
    options: [
      { value: 'https://api.minimaxi.com', label: '国内' },
      { value: 'https://api.minimax.io', label: '国际' },
    ],
  },
  { key: 'minimaxModel', type: 'string', label: 'MiniMax 模型' },
  { key: 'volcengine', type: 'heading', label: '火山引擎语音', defaultCollapsed: true },
  { key: 'volcengineAppId', type: 'string', label: '火山 App ID', secret: true },
  { key: 'volcengineAccessKey', type: 'string', label: '火山 Access Key', secret: true },
  {
    key: 'volcengineResourceId',
    type: 'string',
    label: '火山资源 ID',
    hint: '在火山控制台开通的资源 ID，如 seed-tts-1.0 / seed-tts-2.0',
  },
  { key: 'volcengineEndpoint', type: 'string', label: '火山语音地址' },
  { key: 'cosyvoice', type: 'heading', label: 'CosyVoice 语音', defaultCollapsed: true },
  { key: 'cosyvoiceEndpoint', type: 'string', label: 'CosyVoice 地址' },
  {
    key: 'cosyvoiceSampleRate',
    type: 'number',
    label: 'CosyVoice 采样率',
    hint: 'CosyVoice 默认 22050，CosyVoice2 使用 24000',
    min: 1,
  },
  {
    key: 'cosyvoiceVoices',
    type: 'list',
    label: 'CosyVoice 声音预设',
    titleKey: 'name',
    itemFields: [
      { key: 'id', type: 'string', label: '声音标识' },
      { key: 'name', type: 'string', label: '声音名称' },
      {
        key: 'mode',
        type: 'select',
        label: '合成模式',
        options: ['sft', 'instruct', 'zero_shot'].map((value) => ({ value, label: value })),
      },
      { key: 'spkId', type: 'string', label: '说话人标识' },
      { key: 'promptText', type: 'textarea', label: '参考音频文字' },
      { key: 'refTrackId', type: 'select', label: '参考音频', options: [], optionsSource: 'tts/ref-tracks' },
    ],
  },
)

// 声音选择器保持现有界面，通过通用列表字段输入克隆或自定义 ID，再合并进候选声音。
// 设置表单按「最近的分组标题」归组，所以要插在各自分组的最后一个字段后面，而不是追加到末尾
for (const [key, after] of [
  ['minimaxCustomVoices', 'minimaxModel'],
  ['volcengineCustomVoices', 'volcengineEndpoint'],
] as const) {
  ttsFields.splice(ttsFields.findIndex((field) => 'key' in field && field.key === after) + 1, 0, {
    key,
    type: 'list',
    label: key === 'minimaxCustomVoices' ? 'MiniMax 自定义声音' : '火山自定义声音',
    titleKey: 'name',
    itemFields: [
      { key: 'id', type: 'string', label: '声音标识' },
      { key: 'name', type: 'string', label: '声音名称' },
    ],
  })
}
