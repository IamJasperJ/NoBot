import { parsePresetWithEnglishDefaults } from '@nobot/core'
import { z } from 'zod'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { validate } from '../../../lib/validate'
import { buildRequestBody, chatCompletion, listModels, toLlmConnection } from '../../../llm/openai'
import { getAttachment, resolveImages, setAttachmentCaption } from '../../../services/attachments'
import { getChatRow } from '../../../services/chats'
import { getApiPresetRow, listApiPresets } from '../../../services/connections'
import { resolveProfile } from '../../../services/profiles'
import { getLanguage } from '../../../services/settings'
import { defineExtension, draftChatId, parseSettingsDraft } from '../../types'

export const captionSettings = z.object({
  connectionId: z.string().default(''),
  model: z.string().default(''),
  prompt: z.string().default("What's in this image? Describe the visible subjects, actions, and setting."),
  alwaysText: z.boolean().default(false),
})

/** 候选接口和实际生成共用解析，避免草稿跟随的连接与生成时不同。 */
export function resolveCaptionConnection(config: z.infer<typeof captionSettings>, chatId?: string) {
  const resolved = resolveProfile(chatId ? getChatRow(chatId) : undefined, !config.connectionId)
  const connection = config.connectionId ? getApiPresetRow(config.connectionId) : resolved.connection
  if (!connection) throw new HttpError(400, 'NO_CONNECTION', t('没有可用的模型连接'))
  return connection
}

/** 上传和手动重试共用同一请求，说明失败不影响原图和聊天。 */
export async function generateCaption(id: string, settings: Record<string, unknown>, chatId?: string) {
  const attachment = getAttachment(id)
  try {
    const config = captionSettings.parse(settings)
    const connection = resolveCaptionConnection(config, chatId)
    const prompt = [
      {
        role: 'user' as const,
        content: `${config.prompt}\nWrite in the UI language. ${getLanguage() === 'zh' ? 'Write in Chinese.' : 'Write in English.'}`,
        images: [id],
      },
    ]
    const samplers = parsePresetWithEnglishDefaults({}).samplers
    const images = await resolveImages(prompt, samplers.imageMaxSize)
    const body = buildRequestBody({
      model: config.model || connection.model,
      messages: prompt,
      images,
      samplers: { ...samplers, stream: false, maxTokens: 1024 },
    })
    let text = ''
    for await (const chunk of chatCompletion({
      connection: toLlmConnection(connection),
      body,
      signal: AbortSignal.timeout(60000),
    }))
      text += chunk.text ?? ''
    text = text.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '').trim()
    if (!text) throw new Error(t('图片说明为空'))
    return await setAttachmentCaption(id, text)
  } catch (error) {
    console.error(t('图片说明生成失败'), error)
    return attachment
  }
}

export default defineExtension({
  id: 'caption',
  name: '图片说明',
  description: '为上传的图片生成文字说明，供不支持看图的模型使用。',
  version: '1.0.0',
  enabledByDefault: false,
  defaultSettings: captionSettings.parse({}),
  settingsSchema: [
    {
      key: 'connectionId',
      label: '看图连接',
      type: 'select',
      optionsSource: 'connections',
      options: [{ value: '', label: '跟随当前会话的连接' }],
    },
    { key: 'model', label: '看图模型', type: 'string', optionsSource: 'models', hint: '留空使用连接的模型' },
    { key: 'prompt', label: '说明提示词', type: 'textarea' },
    { key: 'alwaysText', label: '总是用文字描述代替图片', type: 'boolean' },
  ],
  routes(app, ctx) {
    app.post('/connections', (c) =>
      c.json({
        options: [
          { value: '', label: t('跟随当前会话的连接') },
          ...listApiPresets().map((connection) => ({ value: connection.id, label: connection.name })),
        ],
      }),
    )
    app.post('/models', async (c) => {
      const settings = captionSettings.parse(await parseSettingsDraft(c, ctx.settings))
      const connection = resolveCaptionConnection(settings, await draftChatId(c))
      return c.json({
        options: (await listModels(toLlmConnection(connection))).map((value) => ({
          value,
          label: value,
        })),
      })
    })
    app.post('/attachments/:id', validate('json', z.object({ chatId: z.string().optional() })), async (c) =>
      c.json(await generateCaption(c.req.param('id'), ctx.settings, c.req.valid('json').chatId)),
    )
  },
})
