import { createHash, type Hash } from 'node:crypto'
import { countTokens, promptMessageTokens } from '@nobot/core'
import { toDisplayText } from '@nobot/core/stage'
import {
  deleteSummaryInput,
  editSummaryInput,
  freezeSummaryInput,
  type MessageDTO,
  type SummaryEntryDTO,
  type SummaryStateDTO,
  summaryChatInput,
} from '@nobot/shared'
import { z } from 'zod'
import { HttpError, notFound } from '../../../errors'
import { t } from '../../../i18n'
import { listModels, toLlmConnection } from '../../../llm/openai'
import { getChatRow, loadMessage, loadPath } from '../../../services/chats'
import { getApiPresetRow, listApiPresets } from '../../../services/connections'
import { loadGenerationContext, toHistory } from '../../../services/generation/context'
import { completionLimits } from '../../../services/generation/quiet-prompt'
import { resolveProfile } from '../../../services/profiles'
import { defineExtension, draftChatId, type ExtensionContext, parseSettingsDraft } from '../../types'
import { defaultSettings, parseSettings, settingsSchema } from './settings'

type Context = Omit<ExtensionContext, 'chatId'>
const running = new Set<string>()
const errors = new Map<string, string>()

function hashMessage(hash: Hash, { role, content, status, speakerId, meta }: MessageDTO) {
  // 同样的历史复制到新会话时仍可使用总结。排除的正文和与模型无关的元数据不参与比较。
  const hidden = meta.excluded === true
  hash
    .update(
      JSON.stringify(
        hidden
          ? null
          : [
              role,
              content,
              status,
              speakerId,
              meta.name,
              meta.author?.name,
              meta.context,
              meta.check,
              meta.choice?.counts,
              meta.toolCalls,
              meta.toolCallId,
              meta.toolName,
              meta.images?.map((image) => image.id),
              meta.imageGen?.caption,
              meta.imageGen?.prompt,
              meta.imageGen?.status,
              meta.imageGen?.hidden,
            ],
      ),
    )
    .update('\n')
}

function sourceHash(path: MessageDTO[]): string {
  const hash = createHash('sha256')
  for (const message of path) hashMessage(hash, message)
  return hash.digest('hex')
}

function validSummaryIds(path: MessageDTO[]): Set<string> {
  const last = path.findLastIndex((message) => message.meta.summary)
  const valid = new Set<string>()
  if (last < 0) return valid
  const hash = createHash('sha256')
  for (const message of path.slice(0, last + 1)) {
    hashMessage(hash, message)
    const summary = message.meta.summary
    // 旧版总结没有原始素材快照，继续按原有规则读取。
    if (summary && (summary.sourceHash === undefined || summary.sourceHash === hash.copy().digest('hex')))
      valid.add(message.id)
  }
  return valid
}

/** 素材和状态共用同一条路径及命名规则，避免阈值与实际请求不一致。 */
function material(chatId: string) {
  const ctx = loadGenerationContext(chatId, { requireConnection: false })
  const path = loadPath(ctx.chat.activeLeafId)
  const valid = validSummaryIds(path)
  const names = new Map(toHistory(ctx, ctx.chat.activeLeafId).map((m) => [m.id, m.name]))
  const knownNames = [...new Set(names.values())]
  const nameOf = (m: MessageDTO) =>
    names.get(m.id) ??
    (m.role === 'user'
      ? ctx.persona.name
      : (ctx.members.find((member) => member.id === m.speakerId)?.name ?? m.meta.name ?? ctx.members[0]?.name ?? ''))
  const textOf = (m: MessageDTO) =>
    m.role === 'assistant' ? toDisplayText(m.content, { knownNames, speaker: 'plain' }) : m.content
  const entries: SummaryEntryDTO[] = []
  for (const m of path) {
    if (!m.meta.summary) continue
    const { text, createdAt, auto, coveredCount } = m.meta.summary
    const chars = Array.from(textOf(m))
    entries.push({
      messageId: m.id,
      text,
      createdAt,
      auto,
      coveredCount,
      preview: `${nameOf(m)}：${chars.slice(0, 40).join('')}${chars.length > 40 ? '…' : ''}`,
      ...(!valid.has(m.id) ? { stale: true } : {}),
    })
  }
  const current = entries.findLast((entry) => !entry.stale) ?? null
  const start = current ? path.findIndex((m) => m.id === current.messageId) + 1 : 0
  const candidates = path
    .slice(start, -1)
    .filter(
      (m) =>
        (m.role === 'user' || m.role === 'assistant') &&
        (m.status === 'done' || m.status === 'aborted') &&
        names.has(m.id) &&
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
    history: data.entries.filter((entry) => entry.messageId !== data.current?.messageId).reverse(),
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
    const prompt = settings.prompt.replaceAll('{{words}}', String(settings.words))
    const opts = { chatId, connectionId: settings.connectionId, model: settings.model, maxTokens }
    try {
      let answer: string
      if (settings.mode === 'transcript') {
        const connection = settings.connectionId ? getApiPresetRow(settings.connectionId) : data.ctx.connection
        const { budget } = completionLimits(data.ctx.preset.samplers, connection?.provider ?? 'custom', maxTokens)
        const prefix = `[Existing summary]\n${data.current?.text || '(none)'}\n\n[New conversation]\n`
        const systemTokens = promptMessageTokens({ content: prompt })
        const separatorTokens = countTokens('\n\n')
        let estimated = systemTokens + promptMessageTokens({ content: prefix })
        let count = 0
        for (const candidate of selected) {
          estimated += candidate.tokens + (count > 0 ? separatorTokens : 0)
          if (estimated > budget) break
          count++
        }
        // 正文拼接后分词可能略有变化，再按实际的两条消息核对一次。
        let content = ''
        while (count > 0) {
          content =
            prefix +
            selected
              .slice(0, count)
              .map((m) => m.line)
              .join('\n\n')
          if (systemTokens + promptMessageTokens({ content }) <= budget) break
          count--
        }
        if (!count) throw new Error(t('上下文预算放不下第一条待总结消息，请调整生成预设或总结设置'))
        selected = selected.slice(0, count)
        answer = await ctx.host.complete({
          ...opts,
          summary: t('剧情总结'),
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content },
          ],
        })
      } else {
        const instruction = prompt + (data.current ? `\n\n[Existing summary]\n${data.current.text}` : '')
        // 组装会优先保留最近消息。若这批素材不能全部放入，从更早的叶子尝试较短的批次。
        for (;;) {
          try {
            answer = await ctx.host.quietPrompt({
              ...opts,
              includeHistory: true,
              leafId: selected.at(-1)!.message.id,
              requiredHistoryIds: selected.map((m) => m.message.id),
              instruction,
            })
            break
          } catch (error) {
            if (
              selected.length === 1 ||
              !(error instanceof HttpError) ||
              (error.code !== 'PROMPT_TOO_LONG' && error.code !== 'PROMPT_HISTORY_OMITTED')
            )
              throw error
            selected = selected.slice(0, Math.floor(selected.length / 2))
          }
        }
      }
      const text = answer.trim()
      if (!text) throw new Error(t('模型返回了空总结'))
      const target = selected.at(-1)!.message.id
      const targetIndex = data.path.findIndex((message) => message.id === target)
      const hash = sourceHash(data.path.slice(0, targetIndex + 1))
      const latest = loadPath(target)
      // 切换到其他分支时，原路径仍可保存；素材或增量起点变化时必须重试。
      if (!latest.length) return
      const valid = validSummaryIds(latest)
      const previous = latest.findLast((message) => valid.has(message.id))
      if (
        sourceHash(latest) !== hash ||
        previous?.id !== data.current?.messageId ||
        previous?.meta.summary?.text !== data.current?.text
      )
        throw new Error(t('总结期间对话已变化，请重试'))
      ctx.host.updateMessageMeta(target, {
        summary: { text, createdAt: Date.now(), auto, coveredCount: selected.length, sourceHash: hash },
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
      ctx.host.updateMessageMeta(messageId, {
        summary: { ...message.meta.summary!, text, auto: false, sourceHash: sourceHash(loadPath(messageId)) },
      })
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
        : resolveProfile(chatId ? getChatRow(chatId) : undefined).connection!
      return c.json({
        options: (await listModels(toLlmConnection(connection))).map((value) => ({
          value,
          label: value,
        })),
      })
    })
  },
  hooks: {
    beforePrompt(input, ctx) {
      const path = loadPath(input.chat.leafId)
      const valid = validSummaryIds(path)
      const index = path.findLastIndex((m) => valid.has(m.id))
      const current = path[index]
      if (!current?.meta.summary) return input
      const settings = parseSettings(ctx.settings)
      let history = input.history
      if (settings.skipSummarized) {
        const covered = new Set(path.slice(0, index + 1).map((m) => m.id))
        const recent = new Set(settings.keepRecent > 0 ? history.slice(-settings.keepRecent).map((m) => m.id) : [])
        // 工具结果跟随紧邻的调用者。同一个工具调用 ID 可能在不同轮次复用。
        let calls: Set<string> | undefined
        history = history.filter((m) => {
          if (m.role === 'tool') return m.toolCallId !== undefined && calls?.has(m.toolCallId) === true
          const keep = !covered.has(m.id) || recent.has(m.id)
          calls =
            keep && m.role === 'assistant' && m.toolCalls ? new Set(m.toolCalls.map((call) => call.id)) : undefined
          return keep
        })
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
