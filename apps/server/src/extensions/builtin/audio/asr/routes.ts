import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HttpError } from '../../../../errors'
import { t } from '../../../../i18n'
import { currentUser } from '../../../../user-context'
import { transcribe } from './service'
import { asrSettings } from './settings'

export function registerAsrRoutes(app: Hono, ctx: { settings: Record<string, unknown> }) {
  const rates = new Map<string, number[]>()
  app.post(
    '/transcribe',
    bodyLimit({
      maxSize: 26 * 1024 * 1024,
      onError: () => {
        throw new HttpError(413, 'TOO_LARGE', t('文件太大（上限 {limit}MB）', { limit: 25 }))
      },
    }),
    async (c) => {
      const id = currentUser().id
      const recent = (rates.get(id) ?? []).filter((at) => Date.now() - at < 60000)
      if (recent.length >= 10) throw new HttpError(429, 'RATE_LIMITED', t('消息发送过于频繁，请稍后重试'))
      rates.set(id, [...recent, Date.now()])
      const body = await c.req.parseBody()
      if (!(body.file instanceof File)) throw new HttpError(400, 'BAD_AUDIO', t('请选择音频文件'))
      const s = asrSettings.parse(ctx.settings)
      if (body.file.size > s.asrMaxSizeMb * 1024 * 1024)
        throw new HttpError(413, 'TOO_LARGE', t('文件太大（上限 {limit}MB）', { limit: s.asrMaxSizeMb }))
      const result = await transcribe(new Uint8Array(await body.file.arrayBuffer()), body.file.type, ctx.settings, {
        durationMs: body.durationMs === undefined ? undefined : Number(body.durationMs),
        signal: c.req.raw.signal,
      })
      if (result.kind === 'unavailable') throw new HttpError(503, 'ASR_UNAVAILABLE', t('语音识别尚未启用，请发送文字'))
      return c.json(result)
    },
  )
}
