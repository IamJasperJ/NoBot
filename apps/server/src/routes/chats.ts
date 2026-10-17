import {
  activateMessageInput,
  branchInput,
  createBookmarkInput,
  createChatInput,
  excludeMessagesInput,
  type GenerateEvent,
  generateInput,
  generationTypeSchema,
  moveMessageInput,
  swipeInput,
  updateChatInput,
} from '@ai-parter/shared'
import { type Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { HttpError } from '../errors'
import { t } from '../i18n'
import { validate } from '../lib/validate'
import * as bookmarks from '../services/bookmarks'
import * as chats from '../services/chats'
import { assemble, loadGenerationContext } from '../services/context'
import * as generation from '../services/generation'
import { computeStage } from '../services/stage'

/** 把一个生成任务的事件流推给浏览器，直到任务结束或浏览器断开 */
function streamJob(c: Context, job: NonNullable<ReturnType<typeof generation.getJob>>) {
  return streamSSE(c, async (stream) => {
    const queue: GenerateEvent[] = []
    let wake: (() => void) | null = null
    let closed = false

    const unsubscribe = generation.subscribe(job, (e) => {
      queue.push(e)
      wake?.()
    })
    stream.onAbort(() => {
      // 浏览器断开只是不再推送，生成任务继续跑
      closed = true
      unsubscribe()
      wake?.()
    })

    // 每 15 秒发一次心跳，防止模型「思考」太久时连接被中间环节断掉
    const heartbeat = setInterval(() => void stream.write(': ping\n\n'), 15_000)
    try {
      while (!closed) {
        let e = queue.shift()
        while (e) {
          await stream.writeSSE({ event: e.type, data: JSON.stringify(e) })
          if (e.type === 'complete') return
          e = queue.shift()
        }
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        wake = null
      }
    } finally {
      clearInterval(heartbeat)
      unsubscribe()
    }
  })
}

/** 会话、生成、代写、预览、分支 */
export const chatRoutes = new Hono()
  .get('/', validate('query', z.object({ characterId: z.string().optional(), groupId: z.string().optional() })), (c) =>
    c.json(chats.listChats(c.req.valid('query'))),
  )
  .post('/', validate('json', createChatInput), (c) => c.json(chats.createChat(c.req.valid('json'))))
  .get(
    '/:id',
    validate('query', z.object({ before: z.string().optional(), limit: z.coerce.number().int().optional() })),
    (c) => {
      const id = c.req.param('id')
      return c.json(chats.getChatPage(id, c.req.valid('query'), generation.isGenerating(id)))
    },
  )
  /** VN 视图从某条消息开头开始演时，需要这条消息之前的舞台（沿激活路径累加到它的父节点） */
  .get('/:id/stage', validate('query', z.object({ before: z.string() })), (c) => {
    const chatId = c.req.param('id')
    const message = chats.loadMessage(c.req.valid('query').before)
    if (message.chatId !== chatId) throw new HttpError(404, 'NOT_FOUND', t('消息不在这个会话里'))
    return c.json({ stage: computeStage(chatId, chats.loadPath(message.parentId)) })
  })
  .patch('/:id', validate('json', updateChatInput), (c) =>
    c.json(chats.updateChat(c.req.param('id'), c.req.valid('json'))),
  )
  .delete('/:id', async (c) => {
    generation.abortGeneration(c.req.param('id'))
    await chats.deleteChat(c.req.param('id'))
    return c.json({ ok: true })
  })
  .get('/:id/bookmarks', (c) => c.json(bookmarks.listBookmarks(c.req.param('id'))))
  .post('/:id/bookmarks', validate('json', createBookmarkInput), (c) =>
    c.json(bookmarks.createBookmark(c.req.param('id'), c.req.valid('json'))),
  )
  .post('/:id/exclude', validate('json', excludeMessagesInput), (c) =>
    c.json(chats.excludeMessages(c.req.param('id'), c.req.valid('json'))),
  )
  .post('/:id/activate', validate('json', activateMessageInput), (c) =>
    c.json({ leafId: chats.activateMessage(c.req.param('id'), c.req.valid('json').messageId) }),
  )
  .post('/:id/move', validate('json', moveMessageInput), (c) => {
    const { messageId, direction } = c.req.valid('json')
    return c.json({ leafId: chats.moveMessage(c.req.param('id'), messageId, direction) })
  })
  .post('/:id/swipe', validate('json', swipeInput), (c) => {
    const { messageId, direction } = c.req.valid('json')
    return c.json({ leafId: chats.swipe(c.req.param('id'), messageId, direction) })
  })
  .post('/:id/branch', validate('json', branchInput), (c) =>
    c.json(chats.branchChat(c.req.param('id'), c.req.valid('json').messageId)),
  )
  /** 不调用模型，只返回组装好的 Prompt 和组装报告 */
  .post(
    '/:id/prompt-preview',
    validate(
      'json',
      z.object({
        type: generationTypeSchema.optional(),
        text: z.string().optional(),
        speakerId: z.string().optional(),
      }),
    ),
    (c) => {
      const { type, text, speakerId } = c.req.valid('json')
      const ctx = loadGenerationContext(c.req.param('id'), { requireConnection: false })
      const { messages, report } = assemble(ctx, {
        type: type ?? 'normal',
        speakerId: speakerId ?? (ctx.members.find((m) => !m.muted) ?? ctx.members[0])?.id ?? '',
        leafId: ctx.chat.activeLeafId,
        ...(text ? { pending: { role: 'user' as const, content: text } } : {}),
      })
      return c.json({ messages, report })
    },
  )
  .post('/:id/generate', validate('json', generateInput), (c) => {
    const job = generation.startGeneration(c.req.param('id'), c.req.valid('json'))
    return streamJob(c, job)
  })
  /** 刷新页面后重新接上正在进行的生成 */
  .get('/:id/stream', (c) => {
    const job = generation.getJob(c.req.param('id'))
    if (!job) throw new HttpError(404, 'NO_JOB', t('当前没有正在进行的生成'))
    return streamJob(c, job)
  })
  .post('/:id/abort', (c) => {
    generation.abortGeneration(c.req.param('id'))
    return c.json({ ok: true })
  })
  /** 代写：只推文本，不入库。浏览器断开（或点停止）时中止上游请求 */
  .post('/:id/impersonate', (c) => {
    const chatId = c.req.param('id')
    // 先同步校验（没配置连接等），出错直接返回普通错误而不是 SSE
    loadGenerationContext(chatId, { requireConnection: true })
    const controller = new AbortController()
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => controller.abort())
      for await (const e of generation.impersonate(chatId, controller.signal)) {
        await stream.writeSSE({ event: e.type, data: JSON.stringify(e) })
      }
    })
  })
