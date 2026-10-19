import { TRANSLATION_AUTO_MODES, TRANSLATION_LANGUAGES, TRANSLATION_PROVIDERS } from '@ai-parter/shared'
import { z } from 'zod'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { getChatRow } from '../../../services/chats'
import { getApiPresetRow } from '../../../services/connections'
import { resolveProfile } from '../../../services/profiles'
import { getLanguage } from '../../../services/settings'

export const DEFAULT_PROMPT =
  'Translate the following text into the requested target language. Preserve all XML/HTML tags <...>, macros {{...}}, short markers [...], code blocks, URLs, names, and placeholder tokens exactly. Output only the translation, with no commentary.'
export const translationSettings = z.object({
  provider: z.enum(TRANSLATION_PROVIDERS).default('llm'),
  // 空值在请求时按界面语言解析，避免启动时锁死语言。
  targetLanguage: z.string().default(''),
  internalLanguage: z.string().default('en'),
  autoMode: z.enum(TRANSLATION_AUTO_MODES).default('none'),
  translateReasoning: z.boolean().default(false),
  connectionId: z.string().default(''),
  model: z.string().default(''),
  prompt: z.string().default(DEFAULT_PROMPT),
  temperature: z.number().min(0).max(2).default(0.2),
  deeplKey: z.string().default(''),
  deeplEndpoint: z.enum(['free', 'pro']).default('free'),
  deeplxUrl: z.string().default(''),
  libreUrl: z.string().default(''),
  libreKey: z.string().default(''),
  lingvaUrl: z.string().default('https://lingva.ml'),
})
export type TranslationSettings = z.infer<typeof translationSettings>
export const languageOptions = TRANSLATION_LANGUAGES.map(({ code, label }) => ({ value: code, label }))
export function displayLanguage(config: TranslationSettings, lang?: string) {
  return lang || config.targetLanguage || (getLanguage() === 'zh' ? 'zh-CN' : 'en')
}
export function resolveTranslationConnection(config: TranslationSettings, chatId?: string) {
  const resolved = resolveProfile(chatId ? getChatRow(chatId) : undefined, !config.connectionId)
  const connection = config.connectionId ? getApiPresetRow(config.connectionId) : resolved.connection
  if (!connection) throw new HttpError(400, 'NO_CONNECTION', t('没有可用的模型连接'))
  return { connection, model: config.model || (!config.connectionId ? resolved.model : '') || connection.model }
}
