import { AUDIO_KINDS, batchDeleteAudioInput, importAudioUrlInput, updateAudioTrackInput } from '@nobot/shared'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { validate } from '../../../lib/validate'
import {
  AUDIO_LIMIT,
  batchDeleteAudioTracks,
  deleteAudioTrack,
  importAudioUrl,
  listAudioTracks,
  saveAudioTrack,
  updateAudioTrack,
} from '../../../services/audio-library'
import { defineExtension } from '../../types'
import { onBgmEvent, registerChatBgmRoutes } from './chat-bgm'
import { registerTtsRoutes } from './tts/routes'
import { audioSettings, chatBgmFields, ttsFields } from './tts/settings'

const uploadInput = updateAudioTrackInput.required({ name: true }).extend({
  kind: z.enum(AUDIO_KINDS).default('bgm'),
  durationMs: z.coerce.number().finite().nonnegative().optional(),
})
export default defineExtension({
  id: 'audio',
  name: '音频',
  description: 'BGM、音效和语音。VN 里按舞台指令播放背景音乐和音效。',
  version: '1.0.0',
  enabledByDefault: false,
  defaultSettings: audioSettings.parse({}),
  settingsSchema: [
    { key: 'listInPrompt', type: 'boolean', label: '在指令说明里列出曲目', hint: '让模型知道有哪些 BGM 和音效可用' },
    ...chatBgmFields,
    ...ttsFields,
  ],
  hooks: { onEvent: onBgmEvent },
  routes(app, ctx) {
    registerChatBgmRoutes(app, ctx)
    registerTtsRoutes(app, ctx)
    app.get('/tracks', validate('query', z.object({ kind: z.enum(AUDIO_KINDS).optional() })), (c) =>
      c.json(listAudioTracks(c.req.valid('query').kind)),
    )
    app.post(
      '/tracks',
      bodyLimit({
        maxSize: AUDIO_LIMIT + 1024 * 1024,
        onError: () => {
          throw new HttpError(413, 'TOO_LARGE', t('文件太大（上限 {limit}MB）', { limit: 30 }))
        },
      }),
      async (c) => {
        const body = await c.req.parseBody()
        if (!(body.file instanceof File)) throw new HttpError(400, 'BAD_REQUEST', t('请选择音频文件'))
        const data = uploadInput.safeParse({ ...body, name: body.name ?? body.file.name.replace(/\.[^.]+$/, '') })
        if (!data.success) throw new HttpError(400, 'BAD_REQUEST', t('音频参数不合法'))
        return c.json(await saveAudioTrack(new Uint8Array(await body.file.arrayBuffer()), data.data))
      },
    )
    app.post('/tracks/import-url', validate('json', importAudioUrlInput), async (c) =>
      c.json(await importAudioUrl(c.req.valid('json'))),
    )
    app.post('/tracks/batch-delete', validate('json', batchDeleteAudioInput), async (c) => {
      await batchDeleteAudioTracks(c.req.valid('json'))
      return c.json({ ok: true })
    })
    app.patch('/tracks/:id', validate('json', updateAudioTrackInput), (c) =>
      c.json(updateAudioTrack(c.req.param('id'), c.req.valid('json'))),
    )
    app.delete('/tracks/:id', async (c) => {
      await deleteAudioTrack(c.req.param('id'))
      return c.json({ ok: true })
    })
  },
})
