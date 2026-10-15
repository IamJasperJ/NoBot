import type { ChatMessage, GenerateEvent, GenerateInput, MessageDTO, MessageMeta } from '@ai-parter/shared'
import { eq } from 'drizzle-orm'
import { db, newId } from '../db/client'
import { type ApiPresetRow, chats, messages } from '../db/schema'
import { HttpError, notFound } from '../errors'
import { streamChatCompletion } from '../llm/openai'
import { getChatRow, loadMessage } from './chats'
import { assemblePrompt } from './prompt'

/**
 * 生成任务。任务跑在后端，和浏览器连接解耦：
 * - 浏览器刷新或断网，任务继续跑，重新连上后能接着看
 * - 内容先进内存缓冲区，每秒写一次数据库，而不是每个 token 写一次
 */
interface Job {
  chatId: string
  messageId: string
  content: string
  reasoning: string
  controller: AbortController
  startEvent: GenerateEvent
  /** 结束时的事件（error / done），任务结束后才有 */
  endEvents: GenerateEvent[] | null
  listeners: Set<(e: GenerateEvent) => void>
}

const jobs = new Map<string, Job>()
const FLUSH_INTERVAL_MS = 1000

export function isGenerating(chatId: string) {
  return jobs.has(chatId)
}

export function getJob(chatId: string): Job | undefined {
  return jobs.get(chatId)
}

/**
 * 订阅任务事件。会先「回放」到目前为止的状态（开始事件 + 已生成的内容），
 * 所以无论什么时候订阅都不会漏内容。返回取消订阅的函数。
 */
export function subscribe(job: Job, listener: (e: GenerateEvent) => void): () => void {
  listener(job.startEvent)
  if (job.content || job.reasoning) {
    listener({ type: 'delta', text: job.content, ...(job.reasoning ? { reasoning: job.reasoning } : {}) })
  }
  if (job.endEvents) {
    for (const e of job.endEvents) listener(e)
    return () => {}
  }
  job.listeners.add(listener)
  return () => job.listeners.delete(listener)
}

function emit(job: Job, e: GenerateEvent) {
  for (const l of job.listeners) l(e)
}

export function abortGeneration(chatId: string) {
  jobs.get(chatId)?.controller.abort()
}

/**
 * 发起生成。同步完成：组装 Prompt、插入消息、登记任务；
 * 真正调用模型在后台异步进行。
 */
export function startGeneration(chatId: string, input: GenerateInput): Job {
  if (jobs.has(chatId)) throw new HttpError(409, 'BUSY', '这个会话正在生成中，请先等它结束或点停止')
  const chat = getChatRow(chatId)

  // 确定新回复挂在哪：send 挂在新用户消息下；regenerate 挂在目标消息的父节点下（成为它的兄弟）
  let parentId: string | null
  let userText: string | null = null
  if (input.mode === 'send') {
    parentId = chat.activeLeafId
    userText = input.text
  } else {
    const target = db.select().from(messages).where(eq(messages.id, input.targetId)).get()
    if (!target || target.chatId !== chatId) throw notFound('消息')
    if (target.role !== 'assistant' || !target.parentId) {
      throw new HttpError(400, 'BAD_REQUEST', '只能重新生成角色的回复')
    }
    parentId = target.parentId
  }

  // 先组装 Prompt：失败（比如超长）就直接报错，什么都不写入，输入框里的字也不会丢
  const { messages: prompt, preset } = assemblePrompt(
    chat,
    parentId,
    userText !== null ? { role: 'user', content: userText } : undefined,
  )

  const now = Date.now()
  let userMessage: MessageDTO | undefined
  // 先生成用户消息的 id，再生成回复的 id，保证 id 顺序 = 创建顺序
  const userId = userText !== null ? newId() : null
  const assistantId = newId()

  db.transaction((tx) => {
    if (userText !== null && userId) {
      tx.insert(messages)
        .values({ id: userId, chatId, parentId, role: 'user', content: userText, createdAt: now })
        .run()
      parentId = userId
    }
    tx.insert(messages)
      .values({
        id: assistantId,
        chatId,
        parentId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        meta: { model: preset.model },
        createdAt: now,
      })
      .run()
    tx.update(chats).set({ activeLeafId: assistantId, updatedAt: now }).where(eq(chats.id, chatId)).run()
  })

  if (userText !== null && parentId) userMessage = loadMessage(parentId)
  const job: Job = {
    chatId,
    messageId: assistantId,
    content: '',
    reasoning: '',
    controller: new AbortController(),
    startEvent: { type: 'start', assistantMessage: loadMessage(assistantId), ...(userMessage ? { userMessage } : {}) },
    endEvents: null,
    listeners: new Set(),
  }
  jobs.set(chatId, job)

  void runJob(job, preset, prompt)
  return job
}

async function runJob(job: Job, preset: ApiPresetRow, prompt: ChatMessage[]) {
  const started = Date.now()
  let lastFlush = started
  const meta: MessageMeta = { model: preset.model }
  let status: 'done' | 'aborted' | 'error' = 'done'
  let errorEvent: GenerateEvent | null = null

  const flush = () => {
    db.update(messages).set({ content: job.content }).where(eq(messages.id, job.messageId)).run()
    lastFlush = Date.now()
  }

  try {
    for await (const chunk of streamChatCompletion({
      baseUrl: preset.baseUrl,
      apiKey: preset.apiKey,
      model: preset.model,
      params: preset.params,
      messages: prompt,
      signal: job.controller.signal,
    })) {
      if (chunk.text) job.content += chunk.text
      if (chunk.reasoning) job.reasoning += chunk.reasoning
      if (chunk.finishReason) meta.finishReason = chunk.finishReason
      if (chunk.usage) meta.usage = chunk.usage
      if (chunk.text || chunk.reasoning) {
        emit(job, { type: 'delta', text: chunk.text ?? '', ...(chunk.reasoning ? { reasoning: chunk.reasoning } : {}) })
      }
      if (Date.now() - lastFlush > FLUSH_INTERVAL_MS) flush()
    }
  } catch (e) {
    if (job.controller.signal.aborted) {
      status = 'aborted'
    } else {
      status = 'error'
      meta.error = e instanceof Error ? e.message : String(e)
      const code = (e as { code?: string }).code ?? 'GENERATION_FAILED'
      errorEvent = { type: 'error', code, message: meta.error }
    }
  }

  meta.durationMs = Date.now() - started
  if (job.reasoning) meta.reasoning = job.reasoning
  db.update(messages).set({ content: job.content, status, meta }).where(eq(messages.id, job.messageId)).run()

  const doneEvent: GenerateEvent = { type: 'done', message: loadMessage(job.messageId) }
  job.endEvents = errorEvent ? [errorEvent, doneEvent] : [doneEvent]
  for (const e of job.endEvents) emit(job, e)
  job.listeners.clear()
  jobs.delete(job.chatId)
}
