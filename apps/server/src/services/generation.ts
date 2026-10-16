import { buildPrompt, PromptBudgetError, type PromptCharacter, selectSpeakers } from '@ai-parter/core'
import type {
  GenerateEvent,
  GenerateInput,
  GenerationType,
  ImpersonateEvent,
  MessageDTO,
  MessageMeta,
  ToolCall,
} from '@ai-parter/shared'
import { eq } from 'drizzle-orm'
import { db, newId } from '../db/client'
import { chats, messages } from '../db/schema'
import { HttpError, notFound } from '../errors'
import { emitServerEvent, runTransform } from '../extensions/registry'
import { buildRequestBody, chatCompletion } from '../llm/openai'
import { enabledToolNames, runTool, toOpenAITools } from '../tools'
import { getAttachment, redactImages, resolveImages } from './attachments'
import { computeVars, loadMessage, loadPath } from './chats'
import { assemble, type GenerationContext, loadGenerationContext } from './context'
import { insertLog, logError } from './logs'

/**
 * 生成任务。一次任务可能产出多条消息：
 * - 群聊：按发言顺序，每个角色说一条
 * - 工具调用：模型请求调用工具 → 执行 → 插入 tool 消息 → 同一个角色接着写（最多 MAX_TOOL_ROUNDS 轮）
 *
 * 任务跑在后端，和浏览器连接解耦：浏览器刷新或断网，任务继续跑，重新连上后能接着看。
 * 内容先进内存，每秒写一次数据库，而不是每个 token 写一次。
 */

const MAX_TOOL_ROUNDS = 5
const FLUSH_INTERVAL_MS = 1000

interface Job {
  chatId: string
  controller: AbortController
  /** 正在生成的那条消息；两条消息之间为 null */
  current: { startEvent: GenerateEvent; base: string; content: string; reasoning: string } | null
  /** 任务结束后才有：结束时推送过的事件，结束后订阅的人会收到 */
  finished: GenerateEvent[] | null
  listeners: Set<(e: GenerateEvent) => void>
}

const jobs = new Map<string, Job>()

export const isGenerating = (chatId: string) => jobs.has(chatId)
export const getJob = (chatId: string) => jobs.get(chatId)
export const abortGeneration = (chatId: string) => jobs.get(chatId)?.controller.abort()

/**
 * 订阅任务事件。会先「回放」当前这条消息到目前为止的状态（开始事件 + 已生成的内容），
 * 所以无论什么时候订阅都不会漏内容。之前已经完成的消息不回放（重新连接的前端会重新拉取会话）。
 */
export function subscribe(job: Job, listener: (e: GenerateEvent) => void): () => void {
  if (job.current) {
    const { startEvent, base, content, reasoning } = job.current
    listener(startEvent)
    const text = content.slice(base.length)
    if (text || reasoning) listener({ type: 'delta', text, ...(reasoning ? { reasoning } : {}) })
  }
  if (job.finished) {
    for (const e of job.finished) listener(e)
    return () => {}
  }
  job.listeners.add(listener)
  return () => job.listeners.delete(listener)
}

function emit(job: Job, e: GenerateEvent) {
  for (const l of job.listeners) l(e)
}

const setLeaf = (chatId: string, leafId: string) =>
  db.update(chats).set({ activeLeafId: leafId, updatedAt: Date.now() }).where(eq(chats.id, chatId)).run()

// ---------------------------------------------------------------------------
// 发起
// ---------------------------------------------------------------------------

interface Plan {
  type: GenerationType
  /** 第一位发言者的回复挂在这条消息下面 */
  parentId: string | null
  speakers: string[]
  /** 续写时被续写的消息 */
  continueTarget: MessageDTO | null
  userMessage?: MessageDTO
}

/** 群聊里自上一条用户消息以来已经说过话的角色（pooled 发言顺序用） */
function spokenSinceUser(leafId: string | null): string[] {
  const path = loadPath(leafId)
  const spoken: string[] = []
  for (let i = path.length - 1; i >= 0; i--) {
    const m = path[i] as MessageDTO
    if (m.role === 'user') break
    if (m.role === 'assistant' && m.speakerId) spoken.push(m.speakerId)
  }
  return spoken
}

function pickSpeakers(
  ctx: GenerationContext,
  leafId: string | null,
  userTriggered: boolean,
  forced?: string,
): string[] {
  if (!ctx.group) return [ctx.members[0]?.id as string]
  const last = leafId ? loadMessage(leafId) : null
  return selectSpeakers({
    members: ctx.group.members.map((m) => ({
      id: m.characterId,
      name: m.name,
      muted: m.muted,
      talkativeness: m.talkativeness,
    })),
    activation: ctx.group.activation,
    allowSelfResponses: ctx.group.allowSelfResponses,
    lastMessage: last ? { role: last.role, speakerId: last.speakerId, content: last.content } : null,
    spokenSinceUser: spokenSinceUser(leafId),
    userTriggered,
    ...(forced ? { forcedSpeakerId: forced } : {}),
    random: Math.random,
  })
}

/**
 * 发起生成。同步完成：校验、组装一遍 Prompt（失败就直接报错，什么都不写入）、插入用户消息、登记任务；
 * 真正调用模型在后台异步进行。
 */
export function startGeneration(chatId: string, input: GenerateInput): Job {
  if (jobs.has(chatId)) throw new HttpError(409, 'BUSY', '这个会话正在生成中，请先等它结束或点停止')
  const ctx = loadGenerationContext(chatId, { requireConnection: true })
  const leafId = ctx.chat.activeLeafId
  const enabledTools = enabledToolNames(chatId, ctx.preset.samplers)
  const firstMember = ctx.members[0]?.id as string

  let plan: Plan
  const attachments = input.mode === 'send' ? input.images.map(getAttachment) : []
  let pendingUserText: string | null = null
  switch (input.mode) {
    case 'send': {
      pendingUserText =
        input.text.trim() || attachments.length ? input.text : ctx.preset.utility.sendIfEmpty || input.text
      plan = { type: 'normal', parentId: leafId, speakers: ctx.group ? [] : [firstMember], continueTarget: null }
      break
    }
    case 'regenerate': {
      const target = db.select().from(messages).where(eq(messages.id, input.targetId)).get()
      if (!target || target.chatId !== chatId) throw notFound('消息')
      if (target.role !== 'assistant' || !target.parentId) {
        throw new HttpError(400, 'BAD_REQUEST', '只能重新生成角色的回复')
      }
      plan = {
        type: 'regenerate',
        parentId: target.parentId,
        speakers: [target.speakerId ?? firstMember],
        continueTarget: null,
      }
      break
    }
    case 'continue': {
      const target = loadMessage(input.targetId)
      if (target.chatId !== chatId) throw notFound('消息')
      if (target.role !== 'assistant' || target.id !== leafId) {
        throw new HttpError(400, 'BAD_REQUEST', '只能续写当前最后一条角色回复')
      }
      plan = {
        type: 'continue',
        parentId: target.parentId,
        speakers: [target.speakerId ?? firstMember],
        continueTarget: target,
      }
      break
    }
    case 'trigger': {
      plan = {
        type: 'normal',
        parentId: leafId,
        speakers: pickSpeakers(ctx, leafId, false, input.speakerId),
        continueTarget: null,
      }
      if (plan.speakers.length === 0) throw new HttpError(400, 'NO_SPEAKER', '没有可以发言的角色（成员都被静音了？）')
      break
    }
  }

  // 先组装一遍第一位发言者的 Prompt：超长、缺连接等问题在这里就报错，不写入任何东西
  const preflight = assemble(ctx, {
    type: plan.type,
    speakerId: plan.speakers[0] ?? firstMember,
    leafId: plan.continueTarget ? plan.continueTarget.id : plan.parentId,
    enabledTools,
    ...(pendingUserText !== null ? { pending: { role: 'user' as const, content: pendingUserText } } : {}),
  })

  if (attachments.length) {
    const pending = preflight.input.history.find((message) => message.id === 'pending')
    if (pending) pending.images = attachments.map((image) => image.id)
    try {
      buildPrompt(preflight.input)
    } catch (error) {
      if (error instanceof PromptBudgetError) throw new HttpError(400, 'PROMPT_TOO_LONG', error.message)
      throw error
    }
  }

  if (pendingUserText !== null) {
    const userId = newId()
    db.insert(messages)
      .values({
        id: userId,
        chatId,
        parentId: leafId,
        role: 'user',
        content: runTransform('transformInput', pendingUserText, chatId),
        meta: { name: ctx.persona.name, ...(attachments.length ? { images: attachments } : {}) },
        createdAt: Date.now(),
      })
      .run()
    setLeaf(chatId, userId)
    plan.parentId = userId
    plan.userMessage = loadMessage(userId)
    emitServerEvent({ type: 'message:saved', message: plan.userMessage })
    // 群聊：用户发言之后再按发言顺序决定谁来回复
    if (ctx.group) plan.speakers = pickSpeakers(ctx, userId, true)
  }

  const job: Job = { chatId, controller: new AbortController(), current: null, finished: null, listeners: new Set() }
  jobs.set(chatId, job)
  void runJob(job, ctx, plan)
  return job
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

async function runJob(job: Job, ctx: GenerationContext, plan: Plan) {
  const finished: GenerateEvent[] = []
  try {
    // 群聊手动模式下用户发了消息：只保存用户消息，不自动回复
    if (plan.speakers.length === 0 && plan.userMessage) {
      const e: GenerateEvent = { type: 'message', message: plan.userMessage }
      finished.push(e)
      emit(job, e)
    }
    let parentId = plan.parentId
    speakers: for (const [index, speakerId] of plan.speakers.entries()) {
      let type: GenerationType = index === 0 ? plan.type : 'normal'
      let continueTarget = index === 0 ? plan.continueTarget : null
      let userMessage = index === 0 ? plan.userMessage : undefined

      for (let round = 0; ; round++) {
        if (job.controller.signal.aborted) break speakers
        const step = await generateOne(job, ctx, { speakerId, parentId, type, continueTarget, userMessage })
        if (step.error) finished.push(step.error)
        parentId = step.message.id
        // 出错或被中止：整个任务停下（群聊后面的人也不再发言）
        if (step.message.status !== 'done') break speakers
        const canUseTools = ctx.preset.samplers.functionCalling && round < MAX_TOOL_ROUNDS
        if (!canUseTools || step.toolCalls.length === 0) break

        // 执行工具，结果作为 tool 消息挂在消息树上，然后同一个角色接着写
        for (const call of step.toolCalls) {
          const vars = computeVars(loadPath(parentId))
          const result = await runTool(
            call.name,
            call.arguments,
            { chatId: job.chatId, vars },
            ctx.preset.samplers.disabledTools,
          )
          const toolId = newId()
          const meta: MessageMeta = { ...result.meta, toolCallId: call.id, toolName: call.name }
          if (result.varsPatch) meta.varsPatch = result.varsPatch
          db.insert(messages)
            .values({
              id: toolId,
              chatId: job.chatId,
              parentId,
              role: 'tool',
              content: result.content,
              meta,
              createdAt: Date.now(),
            })
            .run()
          setLeaf(job.chatId, toolId)
          parentId = toolId
          emitServerEvent({ type: 'message:saved', message: loadMessage(toolId) })
          emit(job, { type: 'message', message: loadMessage(toolId) })
          if (result.onSaved) {
            try {
              await result.onSaved(toolId)
            } catch (error) {
              logError('扩展工具保存回调', error)
            }
          }
        }
        type = 'normal'
        continueTarget = null
        userMessage = undefined
      }
    }
  } catch (e) {
    console.error('生成任务出错：', e)
    const err: GenerateEvent = { type: 'error', code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) }
    finished.push(err)
    emit(job, err)
  } finally {
    emitServerEvent({ type: 'generation:complete', chatId: job.chatId })
    job.current = null
    job.finished = [...finished, { type: 'complete' }]
    emit(job, { type: 'complete' })
    job.listeners.clear()
    jobs.delete(job.chatId)
  }
}

interface StepInput {
  speakerId: string
  parentId: string | null
  type: GenerationType
  continueTarget: MessageDTO | null
  userMessage?: MessageDTO | undefined
}

/** 生成一条角色回复（或续写一条），返回最终消息和模型请求的工具调用 */
async function generateOne(
  job: Job,
  ctx: GenerationContext,
  step: StepInput,
): Promise<{ message: MessageDTO; toolCalls: ToolCall[]; error?: GenerateEvent }> {
  const connection = ctx.connection
  if (!connection) throw new HttpError(400, 'NO_API_PRESET', '还没有配置模型连接')
  const speaker = (ctx.members.find((m) => m.id === step.speakerId) ?? ctx.members[0]) as PromptCharacter
  const started = Date.now()
  const enabledTools = enabledToolNames(job.chatId, ctx.preset.samplers)

  // 1. 准备消息：续写复用原消息，否则插入一条空的 streaming 消息
  let messageId: string
  let base = ''
  if (step.continueTarget) {
    messageId = step.continueTarget.id
    const original = step.continueTarget.content
    base = original ? original + ctx.preset.behavior.continuePostfix : ''
    db.update(messages).set({ status: 'streaming' }).where(eq(messages.id, messageId)).run()
  } else {
    messageId = newId()
    db.insert(messages)
      .values({
        id: messageId,
        chatId: job.chatId,
        parentId: step.parentId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        speakerId: speaker.id,
        meta: { name: speaker.name, model: connection.model },
        createdAt: Date.now(),
      })
      .run()
    setLeaf(job.chatId, messageId)
  }

  const startEvent: GenerateEvent = {
    type: 'start',
    assistantMessage: { ...loadMessage(messageId), content: base },
    ...(step.userMessage ? { userMessage: step.userMessage } : {}),
  }
  const current = { startEvent, base, content: base, reasoning: '' }
  job.current = current
  emit(job, startEvent)

  // 2. 组装 Prompt 并发请求
  const meta: MessageMeta = { ...(step.continueTarget?.meta ?? {}), name: speaker.name, model: connection.model }
  delete meta.error
  let status: 'done' | 'aborted' | 'error' = 'done'
  let errorEvent: GenerateEvent | undefined
  let toolCalls: ToolCall[] = []
  let requestBody: Record<string, unknown> | null = null
  let report: unknown = null
  let lastFlush = Date.now()

  try {
    const assembled = assemble(ctx, {
      type: step.type,
      speakerId: speaker.id,
      leafId: step.continueTarget ? step.continueTarget.id : step.parentId,
      enabledTools,
    })
    report = assembled.report
    const images = await resolveImages(assembled.messages, ctx.preset.samplers.imageMaxSize)
    const body = buildRequestBody({
      images,
      model: connection.model,
      messages: assembled.messages,
      samplers: ctx.preset.samplers,
      ...(enabledTools.length
        ? { tools: toOpenAITools([], job.chatId).filter((item) => enabledTools.includes(item.function.name)) }
        : {}),
    })
    requestBody = redactImages(body, images)
    for await (const chunk of chatCompletion({
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      headers: connection.headers,
      body,
      signal: job.controller.signal,
    })) {
      if (chunk.text) current.content += chunk.text
      if (chunk.reasoning) current.reasoning += chunk.reasoning
      if (chunk.finishReason) meta.finishReason = chunk.finishReason
      if (chunk.usage) meta.usage = chunk.usage
      if (chunk.toolCalls) toolCalls = chunk.toolCalls
      if (chunk.text || chunk.reasoning) {
        emit(job, { type: 'delta', text: chunk.text ?? '', ...(chunk.reasoning ? { reasoning: chunk.reasoning } : {}) })
      }
      if (Date.now() - lastFlush > FLUSH_INTERVAL_MS) {
        db.update(messages).set({ content: current.content }).where(eq(messages.id, messageId)).run()
        lastFlush = Date.now()
      }
    }
  } catch (e) {
    if (job.controller.signal.aborted) status = 'aborted'
    else {
      status = 'error'
      meta.error = e instanceof Error ? e.message : String(e)
      errorEvent = { type: 'error', code: (e as { code?: string }).code ?? 'GENERATION_FAILED', message: meta.error }
      emit(job, errorEvent)
    }
  }

  // 3. 收尾：扩展处理输出 → 记日志 → 写库
  let content = current.content
  if (status === 'done') content = runTransform('transformOutput', content, job.chatId)
  meta.durationMs = Date.now() - started
  if (current.reasoning) meta.reasoning = current.reasoning
  if (toolCalls.length) meta.toolCalls = toolCalls
  else delete meta.toolCalls

  const generated = content.slice(base.length)
  meta.logId = insertLog({
    chatId: job.chatId,
    messageId,
    kind: 'generation',
    status: status === 'done' ? 'ok' : status,
    model: connection.model,
    durationMs: meta.durationMs,
    summary:
      status === 'error' ? (meta.error ?? '') : `${speaker.name}：${generated.slice(0, 60).replace(/\s+/g, ' ')}`,
    request: requestBody,
    response: {
      content: generated,
      reasoning: current.reasoning || undefined,
      finishReason: meta.finishReason,
      usage: meta.usage,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    },
    report,
  })

  // 续写失败时保留原文，状态恢复为 done，免得原来好好的消息变成「失败」
  if (step.continueTarget && status === 'error') {
    content = step.continueTarget.content
    status = 'done'
  }
  db.update(messages).set({ content, status, meta }).where(eq(messages.id, messageId)).run()
  job.current = null
  const message = loadMessage(messageId)
  emitServerEvent({ type: 'message:saved', message })
  emit(job, { type: 'done', message })
  return { message, toolCalls: status === 'done' ? toolCalls : [], ...(errorEvent ? { error: errorEvent } : {}) }
}

// ---------------------------------------------------------------------------
// 代写：让 AI 替用户写一条，只推送文本，不入库
// ---------------------------------------------------------------------------

export async function* impersonate(chatId: string, signal: AbortSignal): AsyncGenerator<ImpersonateEvent> {
  const ctx = loadGenerationContext(chatId, { requireConnection: true })
  const connection = ctx.connection as NonNullable<GenerationContext['connection']>
  // 群聊里代写时，{{char}} 用最后一位发言的角色
  const last = ctx.chat.activeLeafId ? loadMessage(ctx.chat.activeLeafId) : null
  const lastSpeaker = last?.speakerId && ctx.members.some((m) => m.id === last.speakerId) ? last.speakerId : null
  const { messages: prompt, report } = assemble(ctx, {
    type: 'impersonate',
    speakerId: lastSpeaker ?? (ctx.members[0]?.id as string),
    leafId: ctx.chat.activeLeafId,
    toolsEnabled: false,
  })
  const images = await resolveImages(prompt, ctx.preset.samplers.imageMaxSize)
  const body = buildRequestBody({ model: connection.model, messages: prompt, samplers: ctx.preset.samplers, images })
  const started = Date.now()
  let text = ''
  let status: 'ok' | 'error' | 'aborted' = 'ok'
  let error = ''
  try {
    for await (const chunk of chatCompletion({
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      headers: connection.headers,
      body,
      signal,
    })) {
      if (chunk.text) {
        text += chunk.text
        yield { type: 'delta', text: chunk.text }
      }
    }
  } catch (e) {
    if (signal.aborted) status = 'aborted'
    else {
      status = 'error'
      error = e instanceof Error ? e.message : String(e)
      yield { type: 'error', code: (e as { code?: string }).code ?? 'GENERATION_FAILED', message: error }
    }
  } finally {
    insertLog({
      chatId,
      kind: 'impersonate',
      status,
      model: connection.model,
      durationMs: Date.now() - started,
      summary: status === 'error' ? error : `代写：${text.slice(0, 60)}`,
      request: redactImages(body, images),
      response: { content: text },
      report,
    })
  }
  yield { type: 'complete' }
}
