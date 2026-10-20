import { chatVoiceConfigSchema, TTS_ENGINES, voiceRefSchema } from '@nobot/shared'
import type { Hono } from 'hono'
import { z } from 'zod'
import { HttpError } from '../../../../errors'
import { t } from '../../../../i18n'
import { validate } from '../../../../lib/validate'
import { listAudioTracks } from '../../../../services/audio-library'
import { getCharacterRow, updateCharacter } from '../../../../services/characters'
import { listApiPresets } from '../../../../services/connections'
import { getLanguage } from '../../../../services/settings'
import type { ExtensionStorage } from '../../../types'
import { parseSettingsDraft } from '../../../types'
import { chatVoiceDTO, chatVoiceKey, effectiveSettings } from './chat-voice'
import { ttsEngines } from './engines'
import { fishClient } from './fish'
import { cacheEntries, cleanTtsText, clearTtsCache, messageSegments, resolveVoice, synthesizeVoice } from './service'
import { audioSettings } from './settings'

export const speakerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('character'), characterId: z.string().min(1) }),
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('narrator') }),
  z.object({ kind: z.literal('npc'), name: z.string().min(1) }),
])
export function registerTtsRoutes(app: Hono, ctx: { settings: Record<string, unknown>; storage: ExtensionStorage }) {
  const dto = (chatId: string) => chatVoiceDTO(ctx.storage, chatId, audioSettings.parse(ctx.settings))
  app.get('/tts/chat/:chatId', (c) => c.json(dto(c.req.param('chatId'))))
  app.put('/tts/chat/:chatId', validate('json', chatVoiceConfigSchema), (c) => {
    const chatId = c.req.param('chatId')
    dto(chatId)
    ctx.storage.set(chatVoiceKey(chatId), c.req.valid('json'))
    return c.json(dto(chatId))
  })
  app.delete('/tts/chat/:chatId', (c) => {
    const chatId = c.req.param('chatId')
    dto(chatId)
    ctx.storage.delete(chatVoiceKey(chatId))
    return c.json(dto(chatId))
  })
  app.post('/tts/ref-tracks', (c) =>
    c.json({ options: listAudioTracks('ref').map((v) => ({ value: v.id, label: v.name })) }),
  )
  app.get('/tts/engines', (c) => {
    const settings = audioSettings.parse(ctx.settings)
    return c.json(
      Object.values(ttsEngines).map((engine) => ({
        id: engine.id,
        label: engine.label,
        configured: engine.configured(settings),
      })),
    )
  })
  app.post('/tts/connections', (c) =>
    c.json({
      options: [{ value: '', label: t('单独配置') }, ...listApiPresets().map((v) => ({ value: v.id, label: v.name }))],
    }),
  )
  app.post('/tts/fish/models', (c) =>
    c.json({
      options: [
        { value: 's2.1-pro', label: t('s2.1-pro（推荐）') },
        { value: 's2-pro', label: 's2-pro' },
        { value: 's1', label: 's1' },
      ],
    }),
  )
  app.post('/tts/fish/refresh', (c) => {
    fishClient.clearCache()
    return c.json({ ok: true })
  })
  app.post(
    '/tts/fish/search',
    validate(
      'json',
      z.object({
        query: z.string().optional(),
        language: z.string().optional(),
        self: z.boolean().optional(),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(20),
        settings: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
    async (c) => {
      const settings = audioSettings.parse(await parseSettingsDraft(c, ctx.settings))
      return c.json(await fishClient.search(settings, c.req.valid('json'), c.req.raw.signal))
    },
  )
  app.post(
    '/tts/voices',
    validate('json', z.object({ engine: z.enum(TTS_ENGINES), settings: z.record(z.string(), z.unknown()).optional() })),
    async (c) => {
      const settings = audioSettings.parse(await parseSettingsDraft(c, ctx.settings))
      return c.json({ options: await ttsEngines[c.req.valid('json').engine].voices(settings, c.req.raw.signal) })
    },
  )
  app.get('/tts/voice/character/:id', (c) =>
    c.json(voiceRefSchema.safeParse(getCharacterRow(c.req.param('id')).extensions.nobot_tts).data ?? null),
  )
  app.put('/tts/voice/character/:id', validate('json', z.object({ voice: voiceRefSchema.nullable() })), (c) => {
    const id = c.req.param('id')
    const extensions = { ...getCharacterRow(id).extensions }
    const { voice } = c.req.valid('json')
    if (voice) extensions.nobot_tts = voice
    else delete extensions.nobot_tts
    updateCharacter(id, { extensions })
    return c.json(voice)
  })
  app.post(
    '/tts/line',
    validate(
      'json',
      z.object({
        chatId: z.string().min(1),
        speaker: speakerSchema,
        text: z.string().max(100000),
        expression: z.string().optional(),
      }),
    ),
    async (c) => {
      const input = c.req.valid('json')
      const settings = effectiveSettings(input.chatId, audioSettings.parse(ctx.settings), ctx.storage)
      if (!settings.ttsEnabled) throw new HttpError(400, 'TTS_DISABLED', t('还没有开启朗读'))
      const text = cleanTtsText(input.text)
      if (!text) return c.json({ kind: 'skip', reason: 'empty' } as const)
      const voice = resolveVoice(input.chatId, input.speaker, settings)
      return c.json('kind' in voice ? voice : await synthesizeVoice(voice, text, settings, input.expression))
    },
  )
  app.post('/tts/message', validate('json', z.object({ messageId: z.string().min(1) })), (c) => {
    const result = messageSegments(c.req.valid('json').messageId)
    const settings = effectiveSettings(result.chatId, audioSettings.parse(ctx.settings), ctx.storage)
    if (!settings.ttsEnabled) throw new HttpError(400, 'TTS_DISABLED', t('还没有开启朗读'))
    return c.json(result)
  })
  app.post(
    '/tts/preview',
    validate('json', z.object({ voice: voiceRefSchema, text: z.string().max(10000).optional() })),
    async (c) => {
      const input = c.req.valid('json')
      return c.json(
        await synthesizeVoice(
          input.voice,
          input.text ?? (getLanguage() === 'zh' ? '你好，这是声音试听。' : 'Hello, this is a voice preview.'),
          audioSettings.parse(ctx.settings),
        ),
      )
    },
  )
  app.get('/tts/cache', async (c) => {
    const entries = await cacheEntries()
    return c.json({ bytes: entries.reduce((sum, e) => sum + e.bytes, 0), files: entries.length })
  })
  app.delete('/tts/cache', async (c) => {
    await clearTtsCache()
    return c.json({ ok: true })
  })
}
