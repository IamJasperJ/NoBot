import { countTokens } from '@ai-parter/core'
import { toDisplayText } from '@ai-parter/core/stage'
import {
  deleteSummaryInput,
  editSummaryInput,
  freezeSummaryInput,
  type MessageDTO,
  type SummaryEntryDTO,
  type SummaryStateDTO,
  summaryChatInput,
} from '@ai-parter/shared'
import { z } from 'zod'
import { HttpError, notFound } from '../../../errors'
import { t } from '../../../i18n'
import { listModels } from '../../../llm/openai'
import { getChatRow, loadMessage, loadPath } from '../../../services/chats'
import { getApiPresetRow, listApiPresets, resolveApiPreset } from '../../../services/connections'
import { loadGenerationContext, toHistory } from '../../../services/context'
import { defineExtension, draftChatId, type ExtensionContext, parseSettingsDraft } from '../../types'
import { defaultSettings, parseSettings, settingsSchema } from './settings'

type Context = Omit<ExtensionContext, 'chatId'>
const running = new Set<string>()
const errors = new Map<string, string>()

/** 素材和状态共用同一条路径及命名规则，避免阈值与实际请求不一致。 */
function material(chatId: string) {
  const ctx = loadGenerationContext(chatId, { requireConnection: false })
  const path = loadPath(ctx.chat.activeLeafId)
  const names = new Map(toHistory(ctx, ctx.chat.activeLeafId).map((m) => [m.id, m.name]))
  const nameOf = (m: MessageDTO) =>
    names.get(m.id) ??
    (m.role === 'user'
      ? ctx.persona.name
      : (ctx.members.find((member) => member.id === m.speakerId)?.name ?? m.meta.name ?? ctx.members[0]?.name ?? ''))
  const textOf = (m: MessageDTO) =>
    m.role === 'assistant' ? toDisplayText(m.content, { knownNames: [...names.values()], speaker: 'plain' }) : m.content
  const entries: SummaryEntryDTO[] = path
    .filter((m) => m.meta.summary)
    .map((m) => {
      const chars = Array.from(textOf(m))
      return {
        messageId: m.id,
        ...m.meta.summary!,
        preview: `${nameOf(m)}：${chars.slice(0, 40).join('')}${chars.length > 40 ? '…' : ''}`,
      }
    })
  const current = entries.at(-1) ?? null
  const start = current ? path.findIndex((m) => m.id === current.messageId) + 1 : 0
  const candidates = path
    .slice(start, -1)
    .filter(
      (m) =>
        (m.role === 'user' || m.role === 'assistant') &&
        (m.status === 'done' || m.status === 'aborted') &&
        !m.meta.excluded &&
        m.content.trim() &&
        textOf(m).trim(),
    )
    .map((m) => {
      const line = `${nameOf(m)}：${textOf(m)}`
      return { message: m, line, tokens: countTokens(line) }
    })
  return { ctx, path, entries, current, candidates }
}
function state(ctx: Context, chatId: string): SummaryStateDTO {
  const data = material(chatId)
  return {
    current: data.current,
    history: data.entries.slice(0, -1).reverse(),
    pending: { messages: data.candidates.length, tokens: data.candidates.reduce((n, m) => n + m.tokens, 0) },
    frozen: ctx.storage.get<boolean>(`frozen:${chatId}`) === true,
    running: running.has(chatId),
    lastError: errors.get(chatId) ?? null,
  }
}

async function summarize(ctx: Context, chatId: string, auto: boolean) {
  getChatRow(chatId)
  if (running.has(chatId)) {
    if (auto) return
    throw new HttpError(409, 'BUSY', t('正在总结'))
  }
  running.add(chatId)
  try {
    const data = material(chatId)
    if (!data.candidates.length) {
      if (auto) return
      throw new HttpError(400, 'NOTHING_TO_SUMMARIZE', t('没有新的内容可以总结'))
    }
    const settings = parseSettings(ctx.settings)
    let selected = settings.maxMessages > 0 ? data.candidates.slice(0, settings.maxMessages) : data.candidates
    const maxTokens = settings.maxTokens || settings.words * 2
    if (settings.mode === 'transcript') {
      const budget = data.ctx.preset.samplers.contextSize - maxTokens - 500
      let tokens = 0
      let count = 0
      for (const candidate of selected) {
        if (count > 0 && tokens + candidate.tokens > budget) break
        tokens += candidate.tokens
        count++
      }
      selected = selected.slice(0, count)
    }
    const prompt = settings.prompt.replaceAll('{{words}}', String(settings.words))
    const opts = { chatId, connectionId: settings.connectionId, model: settings.model, maxTokens }
    try {
      const text = (
        settings.mode === 'transcript'
          ? await ctx.host.complete({
              ...opts,
              summary: t('剧情总结'),
              messages: [
                { role: 'system', content: prompt },
                {
                  role: 'user',
                  content: `[Existing summary]\n${data.current?.text || '(none)'}\n\n[New conversation]\n${selected.map((m) => m.line).join('\n\n')}`,
                },
              ],
            })
          : await ctx.host.quietPrompt({
              ...opts,
              includeHistory: true,
              instruction: prompt + (data.current ? `\n\n[Existing summary]\n${data.current.text}` : ''),
            })
      ).trim()
      if (!text) throw new Error(t('模型返回了空总结'))
      const target = selected.at(-1)!.message.id
      // 请求期间消息可能被删除；不能把旧结果写到另一条消息上。
      if (!loadPath(target, 1).length) return
      ctx.host.updateMessageMeta(target, {
        summary: { text, createdAt: Date.now(), auto, coveredCount: selected.length },
      })
      errors.delete(chatId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.set(chatId, message)
      ctx.host.log({
        chatId,
        kind: 'extension',
        status: 'error',
        summary: t('剧情总结失败'),
        response: { error: message },
      })
    }
  } finally {
    running.delete(chatId)
  }
}
function entry(chatId: string, messageId: string) {
  getChatRow(chatId)
  const message = loadMessage(messageId)
  if (message.chatId !== chatId) throw notFound(t('消息'))
  if (!message.meta.summary) throw notFound(t('总结'))
  return message
}
export default defineExtension({
  id: 'summary',
  name: '剧情总结',
  description: '沿消息分支增量总结剧情，可按需注入上下文。',
  version: '1.0.0',
  enabledByDefault: false,
  defaultSettings,
  settingsSchema,
  routes(app, ctx) {
    app.onError((error, c) => {
      const invalid = error instanceof z.ZodError || error instanceof SyntaxError
      return c.json(
        {
          error: {
            code: error instanceof HttpError ? error.code : invalid ? 'BAD_REQUEST' : 'INTERNAL',
            message: error instanceof HttpError ? error.message : invalid ? t('总结参数不合法') : t('总结接口执行失败'),
          },
        },
        error instanceof HttpError ? error.status : invalid ? 400 : 500,
      )
    })
    app.get('/state', (c) => c.json(state(ctx, summaryChatInput.parse(c.req.query()).chatId)))
    app.post('/run', async (c) => {
      const { chatId } = summaryChatInput.parse(await c.req.json())
      await summarize(ctx, chatId, false)
      return c.json(state(ctx, chatId))
    })
    app.patch('/entry', async (c) => {
      const { chatId, messageId, text } = editSummaryInput.parse(await c.req.json())
      const message = entry(chatId, messageId)
      ctx.host.updateMessageMeta(messageId, { summary: { ...message.meta.summary!, text, auto: false } })
      return c.json(state(ctx, chatId))
    })
    app.delete('/entry', async (c) => {
      const { chatId, messageId } = deleteSummaryInput.parse(await c.req.json())
      entry(chatId, messageId)
      ctx.host.updateMessageMeta(messageId, { summary: undefined })
      return c.json(state(ctx, chatId))
    })
    app.post('/freeze', async (c) => {
      const { chatId, frozen } = freezeSummaryInput.parse(await c.req.json())
      getChatRow(chatId)
      ctx.storage.set(`frozen:${chatId}`, frozen)
      return c.json(state(ctx, chatId))
    })
    app.post('/connections', (c) =>
      c.json({
        options: [
          { value: '', label: t('跟随会话') },
          ...listApiPresets().map((m) => ({ value: m.id, label: m.name })),
        ],
      }),
    )
    app.post('/models', async (c) => {
      const settings = parseSettings(await parseSettingsDraft(c, ctx.settings))
      const chatId = await draftChatId(c)
      const connection = settings.connectionId
        ? getApiPresetRow(settings.connectionId)
        : resolveApiPreset(chatId ? getChatRow(chatId).apiPresetId : null)
      return c.json({
        options: (await listModels(connection.baseUrl, connection.apiKey, connection.headers)).map((value) => ({
          value,
          label: value,
        })),
      })
    })
  },
  hooks: {
    beforePrompt(input, ctx) {
      const path = loadPath(input.chat.leafId)
      const index = path.findLastIndex((m) => m.meta.summary)
      const current = path[index]
      if (!current?.meta.summary) return input
      const settings = parseSettings(ctx.settings)
      let history = input.history
      if (settings.skipSummarized) {
        const covered = new Set(path.slice(0, index + 1).map((m) => m.id))
        const recent = new Set(settings.keepRecent > 0 ? history.slice(-settings.keepRecent).map((m) => m.id) : [])
        const removedCalls = new Set(
          history
            .filter((m) => m.role === 'assistant' && covered.has(m.id) && !recent.has(m.id))
            .flatMap((m) => m.toolCalls?.map((call) => call.id) ?? []),
        )
        // 工具结果的去留完全跟随调用者，避免最近消息边界拆散工具单元。
        const calls = new Set(history.flatMap((m) => m.toolCalls?.map((call) => call.id) ?? []))
        history = history.filter((m) =>
          m.role === 'tool'
            ? !!m.toolCallId && calls.has(m.toolCallId) && !removedCalls.has(m.toolCallId)
            : !covered.has(m.id) || recent.has(m.id),
        )
      }
      return {
        ...input,
        history,
        injections: [
          ...(input.injections ?? []),
          {
            id: 'summary',
            label: t('剧情总结'),
            content: settings.template.replaceAll('{{summary}}', current.meta.summary.text),
            position: settings.position,
            depth: settings.position === 'author_note' ? input.chat.authorNoteDepth : settings.depth,
            role: settings.role,
          },
        ],
      }
    },
    onEvent(event, ctx) {
      if (event.type !== 'generation:complete') return
      const settings = parseSettings(ctx.settings)
      if (!settings.auto || ctx.storage.get<boolean>(`frozen:${event.chatId}`)) return
      // 删除会话后到达的迟到事件无需继续读取或保留内存状态。
      try {
        const pending = state(ctx, event.chatId).pending
        if (
          (settings.interval > 0 && pending.messages >= settings.interval) ||
          (settings.tokenThreshold > 0 && pending.tokens >= settings.tokenThreshold)
        )
          void summarize(ctx, event.chatId, true).catch(() => {})
      } catch {
        errors.delete(event.chatId)
      }
    },
  },
})
