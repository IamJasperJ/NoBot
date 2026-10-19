import { parsePresetWithEnglishDefaults } from '@ai-parter/core'
import { z } from 'zod'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { buildRequestBody, chatCompletion, toLlmConnection } from '../../../llm/openai'
import { protect, splitTranslation } from './protection'
import { resolveTranslationConnection, type TranslationSettings } from './settings'

export function deeplLanguage(lang: string) {
  return (
    ({ 'zh-cn': 'ZH-HANS', 'zh-tw': 'ZH-HANT', en: 'EN-US', pt: 'PT-PT' } as Record<string, string>)[
      lang.toLowerCase()
    ] ?? lang.toUpperCase()
  )
}
function endpoint(base: string, path: string) {
  const url = new URL(`${base.replace(/\/+$/, '')}${path}`)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(t('翻译服务地址无效'))
  return url.toString()
}
async function request(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60000) })
  const body = await response.text()
  if (!response.ok) throw new Error(`${response.status}: ${body.slice(0, 300)}`)
  try {
    const value: unknown = JSON.parse(body)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const result = value as Record<string, unknown>
      if (result.error || (typeof result.code === 'number' && result.code >= 400)) {
        throw new HttpError(
          502,
          'TRANSLATION_FAILED',
          t('翻译服务报告错误：{detail}', {
            detail: JSON.stringify(result.error ?? result.message ?? result).slice(0, 300),
          }),
        )
      }
    }
    return value
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new Error(t('翻译服务返回无效数据'))
  }
}
function json(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}
async function translateChunk(text: string, lang: string, config: TranslationSettings, chatId?: string) {
  switch (config.provider) {
    case 'llm': {
      const { connection, model } = resolveTranslationConnection(config, chatId)
      const samplers = parsePresetWithEnglishDefaults({}).samplers
      const body = buildRequestBody({
        model,
        samplers: { ...samplers, stream: false, temperature: config.temperature, maxTokens: 8192 },
        messages: [
          {
            role: 'system',
            content: `${config.prompt}\nTarget language: ${lang}. Write only in the target language. Preserve every ZXQ placeholder token exactly once.`,
          },
          { role: 'user', content: text },
        ],
      })
      let result = ''
      for await (const chunk of chatCompletion({
        connection: toLlmConnection(connection),
        body,
        signal: AbortSignal.timeout(60000),
      }))
        result += chunk.text ?? ''
      return result.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '').trim()
    }
    case 'google': {
      const query = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: lang, dt: 't' })
      const data = await request(`https://translate.googleapis.com/translate_a/single?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ q: text }).toString(),
      })
      return z
        .tuple([z.array(z.tuple([z.string()]).rest(z.unknown()))])
        .rest(z.unknown())
        .parse(data)[0]
        .map((part) => part[0])
        .join('')
    }
    case 'deepl': {
      if (!config.deeplKey) throw new Error(t('请先配置翻译服务密钥'))
      const data = await request(
        `https://${config.deeplEndpoint === 'pro' ? 'api' : 'api-free'}.deepl.com/v2/translate`,
        {
          ...json({ text: [text], target_lang: deeplLanguage(lang) }),
          headers: { 'Content-Type': 'application/json', Authorization: `DeepL-Auth-Key ${config.deeplKey}` },
        },
      )
      return z.object({ translations: z.array(z.object({ text: z.string() })).min(1) }).parse(data).translations[0]!
        .text
    }
    case 'deeplx': {
      const data = await request(
        endpoint(config.deeplxUrl, '/translate'),
        json({ text, source_lang: 'auto', target_lang: deeplLanguage(lang) }),
      )
      return z.object({ data: z.string() }).parse(data).data
    }
    case 'libre': {
      const target = ({ 'zh-CN': 'zh', 'zh-TW': 'zt' } as Record<string, string>)[lang] ?? lang.split('-')[0]!
      const data = await request(
        endpoint(config.libreUrl, '/translate'),
        json({ q: text, source: 'auto', target, format: 'text', api_key: config.libreKey }),
      )
      return z.object({ translatedText: z.string() }).parse(data).translatedText
    }
    case 'lingva': {
      const target = lang.startsWith('zh') ? 'zh' : lang.split('-')[0]!
      const data = await request(
        endpoint(config.lingvaUrl, `/api/v1/auto/${encodeURIComponent(target)}/${encodeURIComponent(text)}`),
      )
      return z.object({ translation: z.string() }).parse(data).translation
    }
  }
}

/** 所有服务共用结构保护和错误边界，禁止把损坏的译文存入消息。 */
export async function translateText(text: string, lang: string, config: TranslationSettings, chatId?: string) {
  try {
    const protectedText = protect(text)
    const chunks = splitTranslation(protectedText.text, config.provider === 'deepl' ? 1500 : 5000, protectedText.tokens)
    let result = ''
    for (const chunk of chunks) {
      if (!chunk.trim()) {
        result += chunk
        continue
      }
      // 服务通常会修剪空白，边界空白由本地保留。
      const leading = /^\s*/.exec(chunk)![0]
      const trailing = /\s*$/.exec(chunk)![0]
      const translated = await translateChunk(chunk.trim(), lang, config, chatId)
      if (!translated.trim()) throw new Error(t('翻译结果为空'))
      result += leading + translated.trim() + trailing
    }
    return protectedText.restore(result)
  } catch (error) {
    if (error instanceof HttpError) throw error
    const detail =
      error instanceof z.ZodError ? t('翻译服务返回无效数据') : error instanceof Error ? error.message : String(error)
    throw new HttpError(
      502,
      'TRANSLATION_FAILED',
      t('翻译失败（{provider}）：{detail}', { provider: config.provider, detail: detail.slice(0, 300) }),
    )
  }
}
