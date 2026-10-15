import { join } from 'node:path'
import {
  apiPresetInput,
  characterUpdateInput,
  createChatInput,
  editMessageInput,
  type GenerateEvent,
  generateInput,
  personaInput,
  swipeInput,
  testConnectionInput,
  updateChatInput,
} from '@ai-parter/shared'
import { zValidator } from '@hono/zod-validator'
import { type Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { paths } from './env'
import { HttpError } from './errors'
import * as characters from './services/characters'
import * as chats from './services/chats'
import * as generation from './services/generation'
import * as personas from './services/personas'
import * as presets from './services/presets'
import { assemblePrompt } from './services/prompt'

/**
 * 所有 /api 路由。路由层只做两件事：校验参数、调用 service。
 * 业务逻辑都在 services/ 里。
 */

// 参数校验失败时，返回和其他错误一样的格式
const validate = <T extends z.ZodType, K extends 'json' | 'query' | 'param'>(target: K, schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const message = result.error.issues.map((i) => `${i.path.join('.') || '参数'}：${i.message}`).join('；')
      return c.json({ error: { code: 'VALIDATION', message } }, 400)
    }
  })

// 校验错误提示用中文
z.config(z.locales.zhCN())

export const app = new Hono().basePath('/api')

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status)
  console.error(err)
  return c.json({ error: { code: 'INTERNAL', message: `服务器内部错误：${err.message}` } }, 500)
})

app.get('/health', (c) => c.json({ ok: true }))

// ---- API 预设 ----
app.get('/presets/api', (c) => c.json(presets.listApiPresets()))
app.post('/presets/api', validate('json', apiPresetInput), (c) => c.json(presets.createApiPreset(c.req.valid('json'))))
app.patch('/presets/api/:id', validate('json', apiPresetInput), (c) =>
  c.json(presets.updateApiPreset(c.req.param('id'), c.req.valid('json'))),
)
app.delete('/presets/api/:id', (c) => {
  presets.deleteApiPreset(c.req.param('id'))
  return c.json({ ok: true })
})
app.post('/presets/api/:id/default', (c) => {
  presets.setDefaultApiPreset(c.req.param('id'))
  return c.json({ ok: true })
})
app.post('/presets/api/test', validate('json', testConnectionInput), async (c) =>
  c.json(await presets.testConnection(c.req.valid('json'))),
)

// ---- 人设 ----
app.get('/personas', (c) => c.json(personas.listPersonas()))
app.patch('/personas/:id', validate('json', personaInput), (c) =>
  c.json(personas.updatePersona(c.req.param('id'), c.req.valid('json'))),
)

// ---- 角色 ----
app.get('/characters', (c) => c.json(characters.listCharacters()))
app.get('/characters/:id', (c) => c.json(characters.getCharacter(c.req.param('id'))))
app.post('/characters/import', async (c) => {
  const body = await c.req.parseBody()
  const file = body.file
  if (!(file instanceof File)) throw new HttpError(400, 'BAD_REQUEST', '请上传角色卡文件')
  if (file.size > 20 * 1024 * 1024) throw new HttpError(400, 'TOO_LARGE', '文件太大（上限 20MB）')
  return c.json(await characters.importCharacter(new Uint8Array(await file.arrayBuffer())))
})
app.patch('/characters/:id', validate('json', characterUpdateInput), (c) =>
  c.json(characters.updateCharacter(c.req.param('id'), c.req.valid('json'))),
)
app.delete('/characters/:id', async (c) => {
  await characters.deleteCharacter(c.req.param('id'))
  return c.json({ ok: true })
})

// 头像文件。文件名只允许 ULID + 扩展名，防止 ../ 之类的路径穿越
app.get('/assets/avatars/:file', async (c) => {
  const name = c.req.param('file')
  if (!/^[0-9A-Z]{26}\.(png|webp)$/.test(name)) throw new HttpError(400, 'BAD_REQUEST', '文件名不合法')
  const file = Bun.file(join(paths.avatars, name))
  if (!(await file.exists())) throw new HttpError(404, 'NOT_FOUND', '头像不存在')
  // 地址里带了 ?v=更新时间，内容变了地址就变，所以可以长期缓存
  return new Response(file, { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } })
})

// ---- 会话 ----
app.get('/chats', validate('query', z.object({ characterId: z.string().optional() })), (c) =>
  c.json(chats.listChats(c.req.valid('query').characterId)),
)
app.post('/chats', validate('json', createChatInput), (c) => c.json(chats.createChat(c.req.valid('json'))))
app.get(
  '/chats/:id',
  validate('query', z.object({ before: z.string().optional(), limit: z.coerce.number().int().optional() })),
  (c) => {
    const id = c.req.param('id')
    return c.json(chats.getChatPage(id, c.req.valid('query'), generation.isGenerating(id)))
  },
)
app.patch('/chats/:id', validate('json', updateChatInput), (c) =>
  c.json(chats.updateChat(c.req.param('id'), c.req.valid('json'))),
)
app.delete('/chats/:id', (c) => {
  generation.abortGeneration(c.req.param('id'))
  chats.deleteChat(c.req.param('id'))
  return c.json({ ok: true })
})
app.post('/chats/:id/swipe', validate('json', swipeInput), (c) => {
  const { messageId, direction } = c.req.valid('json')
  return c.json({ leafId: chats.swipe(c.req.param('id'), messageId, direction) })
})

/** 不调用模型，只返回组装好的 Prompt 和组装报告 */
app.post('/chats/:id/prompt-preview', validate('json', z.object({ text: z.string().optional() })), (c) => {
  const chat = chats.getChatRow(c.req.param('id'))
  const { text } = c.req.valid('json')
  const { messages, report } = assemblePrompt(
    chat,
    chat.activeLeafId,
    text ? { role: 'user', content: text } : undefined,
  )
  return c.json({ messages, report })
})

// ---- 生成（SSE） ----

/** 把一个生成任务的事件流推给浏览器，直到任务结束或浏览器断开 */
function streamJob(c: Context, job: ReturnType<typeof generation.startGeneration>) {
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
          if (e.type === 'done') return
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

app.post('/chats/:id/generate', validate('json', generateInput), (c) => {
  const job = generation.startGeneration(c.req.param('id'), c.req.valid('json'))
  return streamJob(c, job)
})

/** 刷新页面后重新接上正在进行的生成 */
app.get('/chats/:id/stream', (c) => {
  const job = generation.getJob(c.req.param('id'))
  if (!job) throw new HttpError(404, 'NO_JOB', '当前没有正在进行的生成')
  return streamJob(c, job)
})

app.post('/chats/:id/abort', (c) => {
  generation.abortGeneration(c.req.param('id'))
  return c.json({ ok: true })
})

// ---- 消息 ----
app.patch('/messages/:id', validate('json', editMessageInput), (c) =>
  c.json(chats.editMessage(c.req.param('id'), c.req.valid('json').content)),
)
app.delete('/messages/:id', (c) => {
  chats.deleteMessage(c.req.param('id'))
  return c.json({ ok: true })
})
