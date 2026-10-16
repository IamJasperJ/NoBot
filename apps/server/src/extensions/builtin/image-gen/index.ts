import { z } from 'zod'
import { HttpError } from '../../../errors'
import { listApiPresets } from '../../../services/connections'
import { defineExtension, parseSettingsQuery } from '../../types'
import { matchInteractive } from './composition'
import { comfyCapabilities, openaiModels, promptModels, testConnection } from './discovery'
import { modes } from './modes'
import { cancel, dismiss, generate, promptPreview, retry, runImageTool, testImage, toBackground } from './pipeline'
import { defaultSettings, parseSettings, settingsSchema } from './settings'
import { placeholders, workflowSource } from './workflow'
import { workflowValidationError } from './workflow-validation'

const generateInput = z.object({
  chatId: z.string().min(1),
  mode: z.enum(modes.map((m) => m.key)),
  messageId: z.string().optional(),
  input: z.string().optional(),
  characterId: z.string().optional(),
  prompt: z.string().min(1).optional(),
  negative: z.string().optional(),
  snapshotId: z.string().optional(),
})
const messageInput = z.object({ messageId: z.string().min(1), index: z.number().int().nonnegative().default(0) })
export default defineExtension({
  id: 'image-gen',
  name: '图片生成',
  version: '1.0.0',
  description: '根据角色和聊天场景生成图片，支持 OpenAI 兼容接口与 ComfyUI。',
  enabledByDefault: true,
  defaultSettings,
  settingsSchema,
  routes(app, ctx) {
    // 校验错误与上游错误保持可读的中文提示，异步错误则写回消息占位框。
    app.onError((error, c) => {
      if (error instanceof HttpError)
        return c.json({ error: { code: error.code, message: error.message } }, error.status)
      return c.json(
        {
          error: {
            code: 'IMAGE_ERROR',
            message: error instanceof z.ZodError ? '图片生成参数不合法，请检查输入和扩展设置' : error.message,
          },
        },
        error instanceof z.ZodError ? 400 : 502,
      )
    })
    app.post('/generate', async (c) => c.json(await generate(ctx, generateInput.parse(await c.req.json()))))
    app.post('/prompt', async (c) => c.json(await promptPreview(ctx, generateInput.parse(await c.req.json()))))
    app.post('/cancel', async (c) => c.json(cancel(ctx, messageInput.parse(await c.req.json()).messageId)))
    app.post('/dismiss', async (c) => c.json(dismiss(ctx, messageInput.parse(await c.req.json()).messageId)))
    app.post('/retry', async (c) => {
      const body = messageInput
        .extend({
          append: z.boolean().default(true),
          prompt: z.string().trim().min(1).optional(),
          negative: z.string().optional(),
        })
        .parse(await c.req.json())
      return c.json(await retry(ctx, body.messageId, body.append, body))
    })
    app.post('/gallery-background', async (c) => {
      const body = z
        .object({ chatId: z.string().min(1), messageId: z.string().min(1), imageId: z.string().min(1) })
        .parse(await c.req.json())
      const { loadMessage } = await import('../../../services/chats')
      const message = loadMessage(body.messageId)
      const index = message.meta.images?.findIndex((image) => image.id === body.imageId) ?? -1
      if (index < 0) throw new HttpError(400, 'IMAGE_MISSING', '这条消息没有指定的图片')
      return c.json(await toBackground(ctx, body.messageId, index, body.chatId))
    })
    app.post('/to-background', async (c) => {
      const body = messageInput.parse(await c.req.json())
      return c.json(await toBackground(ctx, body.messageId, body.index))
    })
    const draft = async (c: import('hono').Context) => {
      const body = z.object({ settings: z.record(z.string(), z.unknown()).optional() }).parse(await c.req.json())
      return { ...ctx, settings: { ...ctx.settings, ...body.settings } }
    }
    app.post('/test', async (c) => c.json(await testImage(await draft(c))))
    app.post('/test-connection', async (c) => c.json(await testConnection(parseSettings((await draft(c)).settings))))
    app.get('/connections', (c) =>
      c.json({ options: listApiPresets().map((item) => ({ value: item.id, label: item.name })) }),
    )
    app.get('/openai/models', async (c) =>
      c.json({ options: await openaiModels(parseSettings(parseSettingsQuery(c, ctx.settings))) }),
    )
    app.get('/prompt/models', async (c) =>
      c.json({
        options: await promptModels(parseSettings(parseSettingsQuery(c, ctx.settings)), c.req.query('chatId')),
      }),
    )
    app.get('/comfy/capabilities', async (c) =>
      c.json(await comfyCapabilities(parseSettings(parseSettingsQuery(c, ctx.settings)))),
    )
    for (const key of ['models', 'samplers', 'schedulers', 'vaes'] as const)
      app.get(`/comfy/${key}`, async (c) => {
        const options = (await comfyCapabilities(parseSettings(parseSettingsQuery(c, ctx.settings))))[key]
        return c.json({ options, [key]: options })
      })
    app.get('/comfy/workflow-inspection', (c) => {
      const settings = parseSettings(parseSettingsQuery(c, ctx.settings))
      const source = workflowSource(settings)
      const error = workflowValidationError(source)
      return c.json({
        error,
        placeholders: [
          ...placeholders,
          ...settings.comfyCustomPlaceholders.map((item) => item.find.replace(/^%|%$/g, '')),
        ].map((name) => ({ name, used: source.includes(`%${name}%`) })),
      })
    })
    app.get('/styles', (c) =>
      c.json({
        options: parseSettings(parseSettingsQuery(c, ctx.settings)).styles.map((item) => ({
          value: item.name,
          label: item.name,
        })),
      }),
    )
    app.get('/comfy/workflows', (c) =>
      c.json({
        options: [
          { value: '', label: '内置默认' },
          { value: 'avatar', label: '角色头像图生图' },
          ...parseSettings(parseSettingsQuery(c, ctx.settings)).comfyWorkflows.map((item) => ({
            value: item.name,
            label: item.name,
          })),
        ],
      }),
    )
    app.get('/gallery', (c) => {
      const query = z
        .object({
          characterId: z.string().min(1),
          limit: z.coerce.number().int().min(1).max(100).default(40),
          offset: z.coerce.number().int().min(0).default(0),
        })
        .parse(c.req.query())
      const images = ctx.host.listGeneratedImages(query.characterId)
      return c.json({ images: images.slice(query.offset, query.offset + query.limit), total: images.length })
    })
  },
  hooks: {
    onEvent(event, ctx) {
      if (
        event.type !== 'message:saved' ||
        event.message.role !== 'user' ||
        !ctx.settings.interactiveMode ||
        ctx.settings.toolEnabled
      )
        return
      const match = matchInteractive(event.message.content)
      if (match)
        void generate(ctx, { chatId: event.message.chatId, ...match, origin: 'interactive' }).catch((error) =>
          ctx.host.log({
            chatId: event.message.chatId,
            kind: 'image',
            status: 'error',
            summary: `交互模式生成失败：${error instanceof Error ? error.message : String(error)}`,
          }),
        )
    },
  },
  tools: (ctx) =>
    ctx.settings.toolEnabled === true
      ? [
          {
            name: 'generate_image',
            description:
              '生成一张图片展示给用户。当用户要求看图、或者故事里出现特别值得展示的画面时调用。不要频繁调用。',
            parameters: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: '英文逗号分隔的关键词，描述画面里能看到的东西' },
                orientation: { type: 'string', enum: ['portrait', 'landscape', 'square'], default: 'portrait' },
                as_background: { type: 'boolean' },
              },
              required: ['prompt'],
            },
            run: (args, toolCtx) => runImageTool(toolCtx.extension ?? { ...ctx, chatId: toolCtx.chatId }, args),
          },
        ]
      : [],
})
