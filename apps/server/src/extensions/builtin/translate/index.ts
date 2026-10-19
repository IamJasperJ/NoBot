import { createHash } from 'node:crypto'
import type { MessageDTO, MessageMeta } from '@nobot/shared'
import { z } from 'zod'
import { getSetting } from '../../../db/client'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { validate } from '../../../lib/validate'
import { listModels, toLlmConnection } from '../../../llm/openai'
import { editMessage, loadMessage } from '../../../services/chats'
import { listApiPresets } from '../../../services/connections'
import { SETTING_KEYS } from '../../../services/settings'
import { defineExtension, draftChatId, type ExtensionContext, parseSettingsDraft } from '../../types'
import { translateText } from './providers'
import { displayLanguage, languageOptions, resolveTranslationConnection, translationSettings } from './settings'

export function sourceHash(text: string) {
  return createHash('sha256').update(text).digest('hex')
}
const messageInput = z.object({ messageId: z.string().min(1), lang: z.string().min(1).max(40).optional() })
const textInput = z.object({
  text: z.string(),
  lang: z.string().min(1).max(40).optional(),
  chatId: z.string().optional(),
})
type Context = Omit<ExtensionContext, 'chatId'>

export async function translateMessage(ctx: Context, messageId: string, lang?: string, auto = false) {
  const message = loadMessage(messageId)
  if (message.status === 'streaming') throw new HttpError(409, 'BUSY', t('这条消息还在生成中，不能编辑'))
  // source 的原文必须可恢复，手动翻译不能覆盖这份数据。
  if (message.meta.translation?.direction === 'source')
    throw new HttpError(409, 'TRANSLATION_SOURCE', t('请先还原输入原文再翻译'))
  const config = translationSettings.parse(ctx.settings)
  const target = displayLanguage(config, lang)
  const text = await translateText(message.content, target, config, message.chatId)
  const reasoning =
    config.translateReasoning && message.meta.reasoning
      ? await translateText(message.meta.reasoning, target, config, message.chatId)
      : undefined
  const latest = loadMessage(messageId)
  // 翻译期间允许编辑或删除；迟到结果不能覆盖更新后的正文和思考过程。
  if (
    latest.content !== message.content ||
    latest.meta.reasoning !== message.meta.reasoning ||
    latest.status === 'streaming' ||
    JSON.stringify(latest.meta.translation) !== JSON.stringify(message.meta.translation)
  )
    throw new HttpError(409, 'TRANSLATION_STALE', t('翻译期间消息已改变，请重试'))
  return ctx.host.updateMessageMeta(messageId, {
    translation: {
      direction: 'display',
      lang: target,
      provider: config.provider,
      text,
      reasoning,
      sourceHash: sourceHash(message.content),
      auto,
    },
  })
}
export function deleteTranslation(ctx: Context, messageId: string): MessageDTO {
  const message = loadMessage(messageId)
  if (message.meta.translation?.direction === 'source') editMessage(messageId, message.meta.translation.text)
  return ctx.host.updateMessageMeta(messageId, { translation: undefined })
}

/** 同步输入钩子无法等待网络；生成任务在入库前调用，开关和设置与内置扩展注册表保持一致。 */
export async function prepareUserTranslation(input: { text: string; meta: MessageMeta }, chatId: string) {
  if (!getSetting<Record<string, boolean>>(SETTING_KEYS.extensionsEnabled)?.translate) return input
  try {
    const config = translationSettings.parse(getSetting(SETTING_KEYS.extensionSettings('translate')) ?? {})
    if (!['inputs', 'both'].includes(config.autoMode) || !input.text.trim()) return input
    const text = await translateText(input.text, config.internalLanguage, config, chatId)
    return {
      text,
      meta: {
        ...input.meta,
        translation: {
          direction: 'source' as const,
          text: input.text,
          lang: 'auto',
          provider: config.provider,
          sourceHash: sourceHash(text),
          auto: true,
        },
      },
    }
  } catch (error) {
    console.error(t('自动翻译失败'), error)
    return input
  }
}

export default defineExtension({
  id: 'translate',
  name: '翻译',
  description: '翻译消息和输入，保留舞台指令与原文。',
  version: '1.0.0',
  enabledByDefault: false,
  defaultSettings: translationSettings.parse({}),
  settingsSchema: [
    {
      key: 'provider',
      label: '翻译服务',
      type: 'select',
      options: [
        { value: 'llm', label: '模型翻译' },
        { value: 'google', label: 'Google 网页翻译' },
        { value: 'deepl', label: 'DeepL' },
        { value: 'deeplx', label: 'DeepLX' },
        { value: 'libre', label: 'LibreTranslate' },
        { value: 'lingva', label: 'Lingva' },
      ],
    },
    {
      key: 'targetLanguage',
      label: '译文语言',
      type: 'select',
      options: [{ value: '', label: '跟随界面语言' }, ...languageOptions],
    },
    { key: 'internalLanguage', label: '模型语言', type: 'select', options: languageOptions },
    {
      key: 'autoMode',
      label: '自动翻译',
      type: 'select',
      options: [
        { value: 'none', label: '不自动翻译' },
        { value: 'responses', label: '翻译回复' },
        { value: 'inputs', label: '翻译我的输入' },
        { value: 'both', label: '都翻译' },
      ],
    },
    { key: 'translateReasoning', label: '翻译思考过程', type: 'boolean' },
    {
      key: 'connectionId',
      label: '翻译连接',
      type: 'select',
      optionsSource: 'connections',
      options: [{ value: '', label: '跟随当前会话的连接' }],
      visibleWhen: { key: 'provider', equals: 'llm' },
    },
    {
      key: 'model',
      label: '翻译模型',
      type: 'string',
      optionsSource: 'models',
      hint: '留空使用连接的模型',
      visibleWhen: { key: 'provider', equals: 'llm' },
    },
    { key: 'prompt', label: '翻译提示词', type: 'textarea', visibleWhen: { key: 'provider', equals: 'llm' } },
    {
      key: 'temperature',
      label: '翻译温度',
      type: 'number',
      min: 0,
      max: 2,
      step: 0.1,
      attachTo: 'model',
      visibleWhen: { key: 'provider', equals: 'llm' },
    },
    {
      key: 'deeplKey',
      label: 'DeepL 密钥',
      type: 'string',
      secret: true,
      visibleWhen: { key: 'provider', equals: 'deepl' },
    },
    {
      key: 'deeplEndpoint',
      label: 'DeepL 端点',
      type: 'select',
      options: [
        { value: 'free', label: '免费版' },
        { value: 'pro', label: '专业版' },
      ],
      visibleWhen: { key: 'provider', equals: 'deepl' },
    },
    { key: 'deeplxUrl', label: 'DeepLX 地址', type: 'string', visibleWhen: { key: 'provider', equals: 'deeplx' } },
    {
      key: 'libreUrl',
      label: 'LibreTranslate 地址',
      type: 'string',
      visibleWhen: { key: 'provider', equals: 'libre' },
    },
    {
      key: 'libreKey',
      label: 'LibreTranslate 密钥',
      type: 'string',
      secret: true,
      attachTo: 'libreUrl',
      visibleWhen: { key: 'provider', equals: 'libre' },
    },
    { key: 'lingvaUrl', label: 'Lingva 地址', type: 'string', visibleWhen: { key: 'provider', equals: 'lingva' } },
  ],
  routes(app, ctx) {
    app.post('/message', validate('json', messageInput), async (c) => {
      const { messageId, lang } = c.req.valid('json')
      return c.json(await translateMessage(ctx, messageId, lang))
    })
    app.delete('/message', validate('json', messageInput.pick({ messageId: true })), (c) =>
      c.json(deleteTranslation(ctx, c.req.valid('json').messageId)),
    )
    app.post('/text', validate('json', textInput), async (c) => {
      const { text, lang, chatId } = c.req.valid('json')
      const config = translationSettings.parse(ctx.settings)
      return c.json({ text: await translateText(text, displayLanguage(config, lang), config, chatId) })
    })
    app.post('/connections', (c) =>
      c.json({
        options: [
          { value: '', label: t('跟随当前会话的连接') },
          ...listApiPresets().map((connection) => ({ value: connection.id, label: connection.name })),
        ],
      }),
    )
    app.post('/models', async (c) => {
      const config = translationSettings.parse(await parseSettingsDraft(c, ctx.settings))
      const { connection } = resolveTranslationConnection(config, await draftChatId(c))
      return c.json({
        options: (await listModels(toLlmConnection(connection))).map((value) => ({ value, label: value })),
      })
    })
    app.post('/test', async (c) => {
      const config = translationSettings.parse(await parseSettingsDraft(c, ctx.settings))
      return c.json({
        text: await translateText('Hello, world!', displayLanguage(config), config, await draftChatId(c)),
      })
    })
  },
  commands: [
    {
      name: 'translate',
      get description() {
        return t('翻译文本；留空翻译最后一条助手消息')
      },
      args: [
        {
          name: 'lang',
          type: 'string',
          get description() {
            return t('目标语言代码')
          },
        },
      ],
      async run(ctx, args, text) {
        const config = translationSettings.parse(ctx.settings)
        if (text.trim()) return translateText(text, displayLanguage(config, args.lang), config, ctx.chatId || undefined)
        const message = ctx.host
          .getChatInfo(ctx.chatId, Number.MAX_SAFE_INTEGER)
          .messages.findLast((message) => message.role === 'assistant' && message.status === 'done')
        if (!message) throw new HttpError(404, 'NOT_FOUND', t('没有可翻译的助手消息'))
        return (await translateMessage(ctx, message.id, args.lang)).meta.translation!.text
      },
    },
  ],
  hooks: {
    async onEvent(event, ctx) {
      if (
        event.type !== 'message:saved' ||
        event.message.role !== 'assistant' ||
        event.message.status !== 'done' ||
        !event.message.content.trim()
      )
        return
      if (!['responses', 'both'].includes(translationSettings.parse(ctx.settings).autoMode)) return
      try {
        await translateMessage(ctx, event.message.id, undefined, true)
      } catch (error) {
        console.error(t('自动翻译失败'), error)
      }
    },
  },
})
