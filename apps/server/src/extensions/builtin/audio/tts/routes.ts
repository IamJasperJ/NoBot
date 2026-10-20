import { TTS_ENGINES, voiceRefSchema } from '@nobot/shared'
import type { Hono } from 'hono'
import { z } from 'zod'
import { HttpError } from '../../../../errors'
import { t } from '../../../../i18n'
import { validate } from '../../../../lib/validate'
import { getCharacterRow, updateCharacter } from '../../../../services/characters'
import { listApiPresets } from '../../../../services/connections'
import { getLanguage } from '../../../../services/settings'
import { parseSettingsDraft } from '../../../types'
import { ttsEngines } from './engines'
import { cacheEntries, cleanTtsText, clearTtsCache, messageSegments, resolveVoice, synthesizeVoice } from './service'
import { audioSettings } from './settings'

export const speakerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('character'), characterId: z.string().min(1) }),
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('narrator') }),
  z.object({ kind: z.literal('npc'), name: z.string().min(1) }),
])
export function registerTtsRoutes(app: Hono, ctx: { settings: Record<string, unknown> }) {
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
      const settings = audioSettings.parse(ctx.settings)
      if (!settings.ttsEnabled) throw new HttpError(400, 'TTS_DISABLED', t('还没有开启朗读'))
      const input = c.req.valid('json')
      const text = cleanTtsText(input.text)
      if (!text) return c.json({ kind: 'skip', reason: 'empty' } as const)
      const voice = resolveVoice(input.chatId, input.speaker, settings)
      return c.json('kind' in voice ? voice : await synthesizeVoice(voice, text, settings, input.expression))
    },
  )
  app.post('/tts/message', validate('json', z.object({ messageId: z.string().min(1) })), (c) =>
    c.json(messageSegments(c.req.valid('json').messageId)),
  )
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
