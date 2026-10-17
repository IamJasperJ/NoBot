import { z } from 'zod'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { listApiPresets } from '../../../services/connections'
import { defineExtension, draftBody, draftChatId, parseSettingsDraft } from '../../types'
import { matchInteractive, resolvePromptStyle } from './composition'
import { comfyCapabilities, openaiModels, promptModels, testConnection } from './discovery'
import { modes } from './modes'
import {
  autoBackground,
  cancel,
  dismiss,
  generate,
  isBackgroundRunning,
  promptPreview,
  retry,
  runImageTool,
  testImage,
  toBackground,
} from './pipeline'
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
            message: error instanceof z.ZodError ? t('图片生成参数不合法，请检查输入和扩展设置') : error.message,
          },
        },
        error instanceof z.ZodError ? 400 : 502,
      )
    })
    app.get('/background-status', (c) => c.json({ running: isBackgroundRunning(c.req.query('chatId') ?? '') }))
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
      if (index < 0) throw new HttpError(400, 'IMAGE_MISSING', t('这条消息没有指定的图片'))
      return c.json(await toBackground(ctx, body.messageId, index, body.chatId))
    })
    app.post('/to-background', async (c) => {
      const body = messageInput.parse(await c.req.json())
      return c.json(await toBackground(ctx, body.messageId, body.index))
    })
    const draft = async (c: import('hono').Context) => {
      return { ...ctx, settings: await parseSettingsDraft(c, ctx.settings) }
    }
    app.post('/test', async (c) => c.json(await testImage(await draft(c))))
    app.post('/test-connection', async (c) => c.json(await testConnection(parseSettings((await draft(c)).settings))))
    app.post('/connections', async (c) =>
      c.json({ options: listApiPresets().map((item) => ({ value: item.id, label: item.name })) }),
    )
    app.post('/openai/models', async (c) =>
      c.json({ options: await openaiModels(parseSettings(await parseSettingsDraft(c, ctx.settings))) }),
    )
    app.post('/prompt/models', async (c) =>
      c.json({
        options: await promptModels(parseSettings(await parseSettingsDraft(c, ctx.settings)), await draftChatId(c)),
      }),
    )
    app.post('/comfy/capabilities', async (c) =>
      c.json(await comfyCapabilities(parseSettings(await parseSettingsDraft(c, ctx.settings)))),
    )
    for (const key of ['models', 'samplers', 'schedulers', 'vaes'] as const)
      app.post(`/comfy/${key}`, async (c) => {
        const options = (await comfyCapabilities(parseSettings(await parseSettingsDraft(c, ctx.settings))))[key]
        return c.json({ options, [key]: options })
      })
    app.post('/comfy/workflow-inspection', async (c) => {
      const settings = parseSettings(await parseSettingsDraft(c, ctx.settings))
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
    app.post('/styles', async (c) =>
      c.json({
        options: parseSettings(await parseSettingsDraft(c, ctx.settings)).styles.map((item) => ({
          value: item.name,
          label: item.name,
        })),
      }),
    )
    app.post('/comfy/workflows', async (c) =>
      c.json({
        options: [
          { value: '', label: t('内置默认') },
          { value: 'avatar', label: t('角色头像图生图') },
          ...parseSettings(await parseSettingsDraft(c, ctx.settings))
            .comfyWorkflows.filter(
              (item, index, items) =>
                item.name.trim() &&
                item.name !== 'avatar' &&
                items.findIndex((other) => other.name === item.name) === index,
            )
            .map((item) => ({
              value: item.name,
              label: item.name,
            })),
        ],
      }),
    )
    app.post('/comfy/workflow-check', async (c) => {
      const settings = parseSettings(await parseSettingsDraft(c, ctx.settings))
      const { json } = z.object({ json: z.string() }).parse(await draftBody(c))
      const error = workflowValidationError(json)
      return c.json({
        valid: !error,
        ...(error ? { error } : {}),
        placeholders: [
          ...new Set([
            ...placeholders,
            ...settings.comfyCustomPlaceholders.map((item) => item.find.replace(/^%|%$/g, '')),
          ]),
        ].map((name) => ({ name, used: json.includes(`%${name}%`) })),
      })
    })
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
      if (event.type === 'generation:complete') {
        void autoBackground(ctx, event.chatId)
        return
      }
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
            summary: t('交互模式生成失败：{error}', { error: error instanceof Error ? error.message : String(error) }),
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
              'Generate an image to show the user. Call when the user asks for an image or a story scene is particularly worth illustrating. Use sparingly.',
            parameters: {
              type: 'object',
              properties: {
                prompt: {
                  type: 'string',
                  description:
                    resolvePromptStyle(parseSettings(ctx.settings)) === 'tags'
                      ? 'One line of English Danbooru-style short tags describing visible elements, most important first: person count, appearance, clothing, expression, pose, scene, lighting, camera.'
                      : 'One paragraph of natural English describing visible appearance, clothing, expression, pose, environment, lighting, mood, and camera.',
                },
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
