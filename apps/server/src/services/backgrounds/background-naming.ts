import { join } from 'node:path'
import { parsePresetWithEnglishDefaults, supportsVision } from '@nobot/core'
import { type NameBackgroundsInput, type NameBackgroundsResult, nameBackgroundsInput } from '@nobot/shared'
import sharp from 'sharp'
import { getSetting } from '../../db/client'
import { paths } from '../../env'
import { HttpError } from '../../errors'
import { captionSettings, resolveCaptionConnection } from '../../extensions/builtin/caption'
import { t } from '../../i18n'
import { firstJsonObject } from '../../lib/json-object'
import { buildRequestBody, chatCompletion, toLlmConnection } from '../../llm/openai'
import { insertLog } from '../logs'
import { getLanguage, SETTING_KEYS } from '../settings'
import { requireBackground, updateBackground } from './backgrounds'

/** 背景库不依赖会话或扩展启用状态，复用图片说明的连接选择规则。 */
export async function nameBackgrounds(input: NameBackgroundsInput): Promise<NameBackgroundsResult> {
  const { ids, apply } = nameBackgroundsInput.parse(input)
  const config = captionSettings.parse(getSetting(SETTING_KEYS.extensionSettings('caption')) ?? {})
  const connection = resolveCaptionConnection(config)
  const model = config.model || connection.model
  if (!supportsVision(model, connection.vision)) {
    throw new HttpError(400, 'NO_VISION', t('当前连接不支持看图，请在「图片说明」扩展里设置一个能看图的连接'))
  }
  const result: NameBackgroundsResult = { items: [], failed: [] }
  for (const id of ids) {
    const started = Date.now()
    const signal = AbortSignal.timeout(60_000)
    let requested = false
    let failed = false
    let reply = ''
    try {
      const background = requireBackground(id)
      if (background.mime.startsWith('video/'))
        throw new HttpError(400, 'VIDEO_BACKGROUND', t('动态视频背景暂不支持 AI 命名'))
      // GIF 默认只解码第一帧；读取原图，避免缩略图丢失场景细节。
      const bytes = await sharp(join(paths.backgrounds, `${id}.${background.mime === 'image/gif' ? 'gif' : 'webp'}`))
        .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
        .jpeg()
        .timeout({ seconds: 60 })
        .toBuffer()
      signal.throwIfAborted()
      const body = buildRequestBody({
        model,
        messages: [
          {
            role: 'user',
            content: `Look at this background image. Give it a short name (2–10 words or Chinese characters), mainly describing the location plus any necessary time or mood, such as "Tavern at dusk". Write a one-sentence description of at most 40 words or Chinese characters. ${getLanguage() === 'zh' ? 'Write in Chinese.' : 'Write in English.'} Output only JSON: {"name": "...", "description": "..."}`,
            images: [id],
          },
        ],
        images: new Map([[id, `data:image/jpeg;base64,${bytes.toString('base64')}`]]),
        samplers: { ...parsePresetWithEnglishDefaults({}).samplers, stream: false, maxTokens: 1024 },
      })
      requested = true
      for await (const chunk of chatCompletion({ connection: toLlmConnection(connection), body, signal })) {
        reply += chunk.text ?? ''
      }
      signal.throwIfAborted()
      const value = firstJsonObject(reply.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '').trim())
      if (!value || typeof value !== 'object') throw new HttpError(400, 'INVALID_REPLY', t('模型返回的 JSON 无效'))
      if (!('name' in value) || typeof value.name !== 'string' || !value.name.trim()) {
        throw new HttpError(400, 'EMPTY_NAME', t('模型返回的名字为空'))
      }
      const name = value.name.trim()
      const description =
        'description' in value && typeof value.description === 'string'
          ? Array.from(value.description.trim()).slice(0, 40).join('')
          : ''
      if (apply) updateBackground(id, { name, description })
      result.items.push({ id, name, description })
    } catch (error) {
      // 不向界面透传供应商或文件系统的英文错误，业务错误保留已翻译的信息。
      const message = error instanceof HttpError ? error.message : t('背景 AI 命名失败或超时')
      failed = true
      result.failed.push({ id, error: message })
    }
    if (requested) {
      try {
        insertLog({
          kind: 'image',
          status: failed ? 'error' : 'ok',
          model,
          durationMs: Date.now() - started,
          summary: t('背景起名'),
          response: reply,
        })
      } catch {
        // 日志写入失败不能中断后续背景的命名。
      }
    }
  }
  return result
}
