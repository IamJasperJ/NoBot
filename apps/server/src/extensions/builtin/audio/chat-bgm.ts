import { matchByName } from '@nobot/core/stage'
import type { Hono } from 'hono'
import { z } from 'zod'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { validate } from '../../../lib/validate'
import { listAudioTracks } from '../../../services/audio/audio-library'
import { backgroundReplyCount } from '../../../services/backgrounds/auto-background'
import { getChatRow, loadPath } from '../../../services/chats'
import { listApiPresets } from '../../../services/connections'
import { computeStage } from '../../../services/generation/stage'
import { logError } from '../../../services/logs'
import type { ExtensionContext, ServerEvent } from '../../types'
import { audioSettings } from './tts/settings'

export interface ChatBgmRecord {
  trackId: string | null
  source: 'manual' | 'auto'
  locked: boolean
  updatedAt: number
}
type Context = Omit<ExtensionContext, 'chatId'>
const key = (chatId: string) => `bgm:${chatId}`
const pending = new Map<string, Promise<ReturnType<typeof readChatBgm>>>()
// 清除或手动选择后，在途的模型回答不能覆盖较新的用户操作。
const revisions = new Map<string, number>()
function revise(chatId: string) {
  revisions.set(chatId, (revisions.get(chatId) ?? 0) + 1)
}
export function readChatBgm(ctx: Context, chatId: string) {
  getChatRow(chatId)
  const record = ctx.storage.get<ChatBgmRecord>(key(chatId))
  if (!record) return null
  return { ...record, track: listAudioTracks('bgm').find((v) => v.id === record.trackId) ?? null }
}
export function autoChatBgm(ctx: Context, chatId: string) {
  const running = pending.get(chatId)
  if (running) return running
  const revision = revisions.get(chatId) ?? 0
  const task = (async () => {
    getChatRow(chatId)
    if (readChatBgm(ctx, chatId)?.locked) return readChatBgm(ctx, chatId)
    const list = listAudioTracks('bgm')
    if (!list.length) throw new HttpError(400, 'EMPTY_AUDIO', t('背景音乐库是空的'))
    const settings = audioSettings.parse(ctx.settings)
    const chatBefore = getChatRow(chatId)
    const history = loadPath(chatBefore.activeLeafId)
      .slice(-6)
      .map((message) => `${message.role}: ${message.content}`)
      .join('\n')
    const reply = await ctx.host.quietPrompt({
      chatId,
      instruction: `Ignore previous format requirements. Recent conversation:\n${history}\n\nSelect the background music from the following list that best fits the current scene. Output only its exact name from the list, or none for silence, with no other text:\n${list.map((track) => `- ${track.name} — ${track.description}`).join('\n')}`,
      includeHistory: false,
      leafId: chatBefore.activeLeafId,
      connectionId: settings.autoBgmConnectionId || undefined,
      model: settings.autoBgmModel || undefined,
    })
    const none =
      reply
        .trim()
        .replace(/^["'`]|["'`]$/g, '')
        .toLowerCase() === 'none'
    const track = none ? null : matchByName(reply, list)
    if (!none && !track) throw new HttpError(400, 'EMPTY_REPLY', t('模型没有选择背景音乐'))
    const chat = getChatRow(chatId)
    if (
      (revisions.get(chatId) ?? 0) !== revision ||
      readChatBgm(ctx, chatId)?.locked ||
      computeStage(chatId, loadPath(chat.activeLeafId))?.scene.bgm !== undefined
    )
      return readChatBgm(ctx, chatId)
    // 等待模型时曲目可能被删除；失效选择不能留下悬空记录。
    if (track && !listAudioTracks('bgm').some((item) => item.id === track.id)) return readChatBgm(ctx, chatId)
    ctx.storage.set(key(chatId), {
      trackId: track?.id ?? null,
      source: 'auto',
      locked: false,
      updatedAt: Date.now(),
    } satisfies ChatBgmRecord)
    return readChatBgm(ctx, chatId)
  })()
  pending.set(chatId, task)
  void task.finally(() => pending.delete(chatId)).catch(() => {})
  return task
}
export function onBgmEvent(event: ServerEvent, ctx: Context) {
  if (event.type !== 'generation:complete') return
  const settings = audioSettings.parse(ctx.settings)
  const chatId = event.chatId
  if (!settings.autoBgm || readChatBgm(ctx, chatId)?.locked) return
  const path = loadPath(getChatRow(chatId).activeLeafId)
  if (computeStage(chatId, path)?.scene.bgm !== undefined) return
  const count = backgroundReplyCount(path)
  if (count > 0 && count % settings.autoBgmEvery === 0)
    void autoChatBgm(ctx, chatId).catch((error) => logError(t('自动选择背景音乐失败'), error))
}
export function registerChatBgmRoutes(app: Hono, ctx: Context) {
  const query = z.object({ chatId: z.string().min(1) })
  app.post('/bgm/connections', (c) =>
    c.json({
      options: [{ value: '', label: t('跟随会话') }, ...listApiPresets().map((v) => ({ value: v.id, label: v.name }))],
    }),
  )
  app.get('/chat-bgm', validate('query', query), (c) => c.json(readChatBgm(ctx, c.req.valid('query').chatId)))
  app.put(
    '/chat-bgm',
    validate('json', query.extend({ trackId: z.string().min(1).nullable(), locked: z.boolean().optional() })),
    (c) => {
      const { chatId, trackId, locked } = c.req.valid('json')
      getChatRow(chatId)
      if (trackId && !listAudioTracks('bgm').some((v) => v.id === trackId))
        throw new HttpError(400, 'BAD_AUDIO', t('请选择背景音乐'))
      revise(chatId)
      ctx.storage.set(key(chatId), {
        trackId,
        source: 'manual',
        locked: locked ?? true,
        updatedAt: Date.now(),
      } satisfies ChatBgmRecord)
      return c.json(readChatBgm(ctx, chatId))
    },
  )
  app.delete('/chat-bgm', validate('query', query), (c) => {
    const { chatId } = c.req.valid('query')
    getChatRow(chatId)
    revise(chatId)
    ctx.storage.delete(key(chatId))
    return c.json({ ok: true })
  })
  app.post('/chat-bgm/auto', validate('json', query), async (c) =>
    c.json(await autoChatBgm(ctx, c.req.valid('json').chatId)),
  )
}
