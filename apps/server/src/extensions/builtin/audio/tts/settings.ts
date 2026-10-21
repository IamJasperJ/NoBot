import { createHash } from 'node:crypto'
import { TONES } from '@nobot/core'
import { deliveryModeSchema, type ExtensionSettingField, GENDERS, voiceRefSchema } from '@nobot/shared'
import { z } from 'zod'
import { t } from '../../../../i18n'

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

const audioSettingsSchema = z.object({
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
  genderMatch: z.boolean().default(true),
  genderInference: z.boolean().default(true),
  autoRead: z.boolean().default(false),
  vnVoice: z.boolean().default(true),
  vnWaitVoice: z.boolean().default(true),
  vnInterrupt: z.boolean().default(true),
  deliveryMode: deliveryModeSchema.default('basic'),
  deliveryDirector: z.boolean().default(false),
  edgeVolume: z.number().int().min(-100).max(100).default(0),
  cacheMaxMb: z.number().finite().nonnegative().default(500),
  openaiConnectionId: z.string().default(''),
  openaiBaseUrl: z.string().default('https://api.openai.com/v1'),
  openaiApiKey: z.string().default(''),
  openaiModel: z.string().default('gpt-4o-mini-tts'),
  fishApiKey: z.string().default(''),
  // 填错或清空时退回默认值：设置整份解析失败会让整个音频扩展不可用
  fishEndpoint: z.url().catch('https://api.fish.audio/v1/tts'),
  fishModel: z.string().trim().min(1).catch('s2.1-pro'),
  fishVoices: z
    .array(
      z.object({
        id: z.string().trim(),
        name: z.string().default(''),
        gender: z.preprocess((v) => (v === '' ? undefined : v), z.enum(GENDERS).optional()),
      }),
    )
    .default([]),
  gptsovitsEndpoint: z.string().default('http://127.0.0.1:9880'),
  gptsovitsVoices: z
    .array(
      z
        .object({
          id: z.string().default(''),
          name: z.string().default(''),
          gender: z.preprocess((v) => (v === '' ? undefined : v), z.enum(GENDERS).optional()),
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
  minimaxCustomVoices: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().default(''),
        gender: z.preprocess((v) => (v === '' ? undefined : v), z.enum(GENDERS).optional()),
      }),
    )
    .default([]),
  volcengineCustomVoices: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().default(''),
        gender: z.preprocess((v) => (v === '' ? undefined : v), z.enum(GENDERS).optional()),
      }),
    )
    .default([]),
  minimaxApiKey: z.string().default(''),
  minimaxApiHost: z.string().default('https://api.minimaxi.com'),
  minimaxModel: z.string().default('speech-02-hd'),
  volcengineAppId: z.string().default(''),
  volcengineAccessKey: z.string().default(''),
  volcengineResourceId: z.string().default('seed-tts-2.0'),
  volcengineEndpoint: z.string().default('https://openspeech.bytedance.com/api/v3/tts/unidirectional'),
  cosyvoiceApi: z.enum(['official', 'gateway']).default('official'),
  cosyvoiceHeaders: z.string().default(''),
  cosyvoiceEndpoint: z.string().default('http://127.0.0.1:50000'),
  cosyvoiceSampleRate: z.number().int().min(1).default(22050),
  cosyvoiceVoices: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        gender: z.preprocess((v) => (v === '' ? undefined : v), z.enum(GENDERS).optional()),
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
/** 必须在合并扩展默认值前迁移，避免默认 basic 遮住旧版 false。 */
export function migrateAudioSettings(record: Record<string, unknown>): Record<string, unknown> {
  const { expressionStyle, ...settings } = record
  return { ...settings, deliveryMode: settings.deliveryMode ?? (expressionStyle === false ? 'off' : 'basic') }
}

/** 旧开关只在未设置新字段时参与迁移，显式的新模式始终优先。 */
export const audioSettings = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return migrateAudioSettings(value as Record<string, unknown>)
}, audioSettingsSchema)
export type AudioSettings = z.infer<typeof audioSettings>
/** 额外请求头沿用其他引擎的 JSON 对象规则，并统一大小写及顺序以稳定缓存。 */
export function cosyvoiceHeaders(text: string): Record<string, string> {
  if (!text.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(t('{label}额外请求头不是合法的 JSON', { label: 'CosyVoice ' }))
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((value) => typeof value !== 'string')
  )
    throw new Error(t('{label}额外请求头必须是字符串值的 JSON 对象', { label: 'CosyVoice ' }))
  return Object.fromEntries(
    [...new Headers(parsed as Record<string, string>).entries()].sort(([a], [b]) => a.localeCompare(b)),
  )
}

export function cosyvoiceHeadersHash(text: string): string {
  return createHash('sha256')
    .update(JSON.stringify(cosyvoiceHeaders(text)))
    .digest('hex')
}
const genderField: ExtensionSettingField = {
  key: 'gender',
  type: 'select',
  label: '声音性别',
  options: [
    { value: '', label: '不确定' },
    { value: 'male', label: '男' },
    { value: 'female', label: '女' },
    { value: 'neutral', label: '中性' },
  ],
}
export const ttsFields: ExtensionSettingField[] = [
  { key: 'tts', type: 'heading', label: '朗读设置' },
  { key: 'genderMatch', type: 'boolean', label: '按性别分配声音' },
  {
    key: 'genderInference',
    type: 'boolean',
    label: '用模型判断角色性别',
    hint: '每个角色只判断一次并缓存；关闭时只用角色卡上手动设置的性别',
  },
  ...(
    [
      ['ttsEnabled', '开启朗读'],
      ['readNarration', '朗读旁白'],
      ['readUser', '朗读用户台词'],
      ['autoRead', '自动朗读新回复'],
      ['vnVoice', 'VN 逐句朗读'],
      ['vnWaitVoice', 'VN 自动播放等待语音'],
      ['vnInterrupt', '切句时打断语音'],
    ] as const
  ).map(([key, label]) => ({ key, label, type: 'boolean' as const })),
  {
    key: 'deliveryMode',
    type: 'select',
    label: '语气控制',
    options: [
      { value: 'off', label: '关：不控制语气' },
      { value: 'basic', label: '基础：按立绘表情' },
      { value: 'rich', label: '丰富：让模型在台词里标注语气和声音' },
    ],
  },
  {
    key: 'deliveryDirector',
    type: 'boolean',
    label: '语音导演',
    hint: '朗读前用模型给整条消息标注语气，每条消息多一次调用',
  },
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
  { key: 'fish', type: 'heading', label: 'Fish Audio 语音', defaultCollapsed: true },
  { key: 'fishApiKey', type: 'string', label: 'Fish Audio 密钥', secret: true },
  {
    key: 'fishEndpoint',
    type: 'string',
    label: 'Fish Audio 语音地址',
    hint: '填写完整 TTS 接口地址，默认 https://api.fish.audio/v1/tts',
  },
  {
    key: 'fishModel',
    type: 'string',
    label: 'Fish Audio 合成模型',
    optionsSource: 'tts/fish/models',
    hint: '例如 s2.1-pro；模型名称与声音 ID 不同',
  },
  {
    key: 'fishVoices',
    type: 'list',
    label: 'Fish Audio 自定义声音',
    hint: '声音标识填写 Fish Audio 的声音模型 ID（reference_id）',
    titleKey: 'name',
    itemFields: [
      { key: 'id', type: 'string', label: '声音标识' },
      { key: 'name', type: 'string', label: '声音名称' },
      genderField,
    ],
  },
  // 搜索 Fish Audio 声音库的控件由前端渲染（值不用），搜到的声音加进上面的 fishVoices
  { key: 'fishVoiceSearch', type: 'custom', label: 'Fish Audio 声音库' },
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
      genderField,
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
  {
    key: 'cosyvoiceApi',
    type: 'select',
    label: '服务类型',
    options: [
      { value: 'official', label: '官方 FastAPI（inference_* 接口）' },
      { value: 'gateway', label: 'OpenAI 兼容网关（/voices + /v1/audio/speech）' },
    ],
    hint: '网关模式会从服务端拉取已保存的音色，不用手填；地址填到网关路由为止，例如 http://host:8800/api/cosyvoice3',
  },
  { key: 'cosyvoiceEndpoint', type: 'string', label: 'CosyVoice 地址' },
  { key: 'cosyvoiceHeaders', type: 'textarea', label: '额外请求头（JSON）' },
  {
    key: 'cosyvoiceSampleRate',
    visibleWhen: { key: 'cosyvoiceApi', equals: 'official' },
    type: 'number',
    label: 'CosyVoice 采样率',
    hint: 'CosyVoice 默认 22050，CosyVoice2 使用 24000',
    min: 1,
  },
  {
    key: 'cosyvoiceVoices',
    visibleWhen: { key: 'cosyvoiceApi', equals: 'official' },
    type: 'list',
    label: 'CosyVoice 声音预设',
    titleKey: 'name',
    itemFields: [
      { key: 'id', type: 'string', label: '声音标识' },
      { key: 'name', type: 'string', label: '声音名称' },
      genderField,
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
      genderField,
    ],
  })
}
