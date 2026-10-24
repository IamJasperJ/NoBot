import { chatVoiceConfigSchema, lineDeliverySchema, spokenCuesSchema, TTS_ENGINES, voiceRefSchema } from '@nobot/shared'
import type { Hono } from 'hono'
import { z } from 'zod'
import { HttpError } from '../../../../errors'
import { t } from '../../../../i18n'
import { validate } from '../../../../lib/validate'
import { listAudioTracks } from '../../../../services/audio/audio-library'
import { getCharacterRow, updateCharacter } from '../../../../services/characters'
import { loadMessage } from '../../../../services/chats'
import { listApiPresets } from '../../../../services/connections'
import { readableMessage } from '../../../../services/rooms/dto'
import { getLanguage } from '../../../../services/settings'
import { currentUser } from '../../../../user-context'
import type { ExtensionHost, ExtensionStorage } from '../../../types'
import { parseSettingsDraft } from '../../../types'
import { chatVoiceDTO, chatVoiceKey, effectiveSettings } from './chat-voice'
import { applyDirection, directMessage, directorDeliverySchema, waitForVnDirections } from './director'
import { ttsEngines } from './engines'
import { fishClient } from './engines/fish'
import { inferGender } from './gender'
import {
  cacheEntries,
  cleanTtsText,
  clearTtsCache,
  messageSegments,
  resolveVoice,
  speakerDeliveryStyle,
  synthesizeVoice,
} from './service'
import { audioSettings } from './settings'

export const speakerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('character'), characterId: z.string().min(1) }),
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('narrator') }),
  z.object({ kind: z.literal('npc'), name: z.string().min(1) }),
])
export function registerTtsRoutes(
  app: Hono,
  ctx: { settings: Record<string, unknown>; storage: ExtensionStorage; host?: Pick<ExtensionHost, 'quietPrompt'> },
) {
  const dto = (chatId: string) => chatVoiceDTO(ctx.storage, chatId, audioSettings.parse(ctx.settings))
  app.get('/tts/chat/:chatId', (c) => c.json(dto(c.req.param('chatId'))))
  app.post('/tts/chat/:chatId/infer-genders', async (c) => {
    const chatId = c.req.param('chatId')
    const before = dto(chatId)
    const settings = audioSettings.parse(ctx.settings)
    const speakers = [
      ...before.members.map((m) => ({ kind: 'character' as const, characterId: m.id })),
      ...before.npcs.map((n) => ({ kind: 'npc' as const, name: n.name })),
    ]
    const queue = [...speakers]
    const worker = async () => {
      for (let speaker = queue.shift(); speaker; speaker = queue.shift())
        await inferGender(
          { ...ctx, userKey: currentUser().handle },
          chatId,
          speaker,
          before.config,
          settings.genderInference,
        )
    }
    await Promise.all([worker(), worker()])
    return c.json(dto(chatId))
  })
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
  app.get(
    '/tts/engines',
    validate('query', z.object({ engine: z.enum(TTS_ENGINES).optional(), voice: z.string().optional() })),
    (c) => {
      const settings = audioSettings.parse(ctx.settings)
      const query = c.req.valid('query')
      return c.json(
        Object.values(ttsEngines)
          .filter((engine) => !query.engine || engine.id === query.engine)
          .map((engine) => ({
            id: engine.id,
            label: engine.label,
            configured: engine.configured(settings),
            delivery: engine.deliveryCapabilities(settings, query.voice),
          })),
      )
    },
  )
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
        delivery: lineDeliverySchema.optional(),
        cues: spokenCuesSchema.optional(),
        director: directorDeliverySchema.optional(),
        messageId: z.string().min(1).optional(),
        beatIndex: z.number().int().nonnegative().optional(),
      }),
    ),
    async (c) => {
      const input = c.req.valid('json')
      if (input.messageId && readableMessage(loadMessage(input.messageId)).meta.hidden)
        throw new HttpError(404, 'NOT_FOUND', t('消息不在这个会话里'))
      const settings = effectiveSettings(input.chatId, audioSettings.parse(ctx.settings), ctx.storage)
      if (!settings.ttsEnabled) throw new HttpError(400, 'TTS_DISABLED', t('还没有开启朗读'))
      if (
        input.messageId &&
        input.beatIndex !== undefined &&
        settings.deliveryDirector &&
        settings.deliveryMode !== 'off'
      ) {
        const message = messageSegments(input.messageId)
        if (message.chatId !== input.chatId) throw new HttpError(400, 'BAD_REQUEST', t('音频参数不合法'))
        const index = message.segments.findIndex((segment) => segment.beatIndex === input.beatIndex)
        if (index >= 0) {
          const directions = await waitForVnDirections(
            directMessage({ ...ctx, userKey: currentUser().handle }, input.messageId, input.chatId, message.segments),
          )
          const segment = applyDirection(message.segments[index]!, directions?.[index])
          if (message.segments[index]!.text === input.text) input.text = segment.text
          else {
            // VN 旁白保留整拍，消息朗读可能按引语拆段；只插入相应子串的声音。
            let text = ''
            let offset = 0
            for (const [i, part] of message.segments.entries()) {
              if (part.beatIndex !== input.beatIndex) continue
              const at = input.text.indexOf(part.text, offset)
              if (at < 0) continue
              const directed = applyDirection(part, directions?.[i])
              text += input.text.slice(offset, at) + directed.text
              offset = at + part.text.length
            }
            input.text = text + input.text.slice(offset)
          }
          input.director = segment.director
        }
      }
      const text = cleanTtsText(input.text)
      if (!text) return c.json({ kind: 'skip', reason: 'empty' } as const)
      const voice = await resolveVoice(input.chatId, input.speaker, settings, { ...ctx, userKey: currentUser().handle })
      return c.json(
        'kind' in voice
          ? voice
          : await synthesizeVoice(
              voice,
              input.text,
              settings,
              input.expression,
              input.delivery,
              input.cues,
              speakerDeliveryStyle(input.speaker, input.chatId),
              settings.deliveryDirector ? input.director : undefined,
            ),
      )
    },
  )
  app.post('/tts/message', validate('json', z.object({ messageId: z.string().min(1) })), async (c) => {
    const messageId = c.req.valid('json').messageId
    if (readableMessage(loadMessage(messageId)).meta.hidden)
      throw new HttpError(404, 'NOT_FOUND', t('消息不在这个会话里'))
    const result = messageSegments(messageId)
    const settings = effectiveSettings(result.chatId, audioSettings.parse(ctx.settings), ctx.storage)
    if (!settings.ttsEnabled) throw new HttpError(400, 'TTS_DISABLED', t('还没有开启朗读'))
    if (settings.deliveryDirector && settings.deliveryMode !== 'off') {
      const directions = await directMessage(
        { ...ctx, userKey: currentUser().handle },
        messageId,
        result.chatId,
        result.segments,
      )
      result.segments = result.segments.map((segment, i) => applyDirection(segment, directions[i]))
    }
    await Promise.all(
      result.segments.map((segment) =>
        resolveVoice(result.chatId, segment.speaker, settings, { ...ctx, userKey: currentUser().handle }),
      ),
    )
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
