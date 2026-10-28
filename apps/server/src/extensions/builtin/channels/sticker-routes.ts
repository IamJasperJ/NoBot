import { and, eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../../../db/client'
import { channelStickerGroups, channelStickers } from '../../../db/schema'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { validate } from '../../../lib/validate'
import { OneBotClient } from './adapters/onebot11/client'
import type { ChannelRuntime } from './runtime'
import { importStickerSet, listStickers, refreshQqFaces } from './stickers'
import { accountRow } from './store'

const patch = z
  .object({
    enabled: z.boolean().optional(),
    characters: z.array(z.string().min(1)).max(100).optional(),
    meanings: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
  })
  .strict()
export function stickerRoutes(app: Hono, runtime: () => ChannelRuntime) {
  const client = (id: string) => runtime().accounts.get(id)?.client ?? runtime().client(accountRow(id).config)
  app.get('/accounts/:id/stickers', (c) => c.json(listStickers(c.req.param('id'))))
  app.post(
    '/accounts/:id/stickers/sets',
    validate('json', z.object({ name: z.string().min(1).max(512) })),
    async (c) => {
      const id = c.req.param('id')
      await importStickerSet(id, c.req.valid('json').name, client(id))
      return c.json(listStickers(id))
    },
  )
  app.post('/accounts/:id/stickers/refresh', async (c) => {
    const id = c.req.param('id')
    accountRow(id)
    const sender = runtime().accounts.get(id)?.client
    if (!(sender instanceof OneBotClient))
      throw new HttpError(409, 'CHANNEL_UNAVAILABLE', t('无法连接机器人平台，请检查网络后重试'))
    if (!sender.napcat) throw new HttpError(400, 'UNSUPPORTED', t('此平台不支持该操作'))
    return c.json(await refreshQqFaces(id, sender, runtime().host, runtime().fetch, c.req.raw.signal))
  })
  app.get('/accounts/:id/stickers/:stickerId/preview', async (c) => {
    const id = c.req.param('id')
    accountRow(id)
    const entry = db
      .select()
      .from(channelStickers)
      .where(and(eq(channelStickers.id, c.req.param('stickerId')), eq(channelStickers.accountId, id)))
      .get()
    if (entry?.ref.kind !== 'telegram' || !entry.ref.thumbnail) throw new HttpError(404, 'NOT_FOUND', t('贴纸不存在'))
    const sender = client(id)
    const file = await sender.call<{ file_path?: string }>('getFile', { file_id: entry.ref.thumbnail })
    if (!file.file_path || !('streamFile' in sender) || typeof sender.streamFile !== 'function')
      throw new HttpError(404, 'NOT_FOUND', t('贴纸不存在'))
    // Bot API 文件地址带 token，不重定向给浏览器；流式透传且禁止磁盘/浏览器缓存。
    // https://core.telegram.org/bots/api#getfile
    return sender.streamFile(file.file_path)
  })
  for (const kind of ['entries', 'sets'] as const) {
    const table = kind === 'entries' ? channelStickers : channelStickerGroups
    const path = `/accounts/:id/stickers/${kind}/:stickerId` as const
    app.patch(path, validate('json', patch), (c) => {
      const id = c.req.param('id')
      accountRow(id)
      const input = c.req.valid('json')
      for (const characterId of input.characters ?? []) runtime().host.getCharacter(characterId)
      const condition = and(eq(table.id, c.req.param('stickerId')), eq(table.accountId, id))
      const value = kind === 'sets' ? { enabled: input.enabled, characters: input.characters } : input
      if (!db.select().from(table).where(condition).get()) throw new HttpError(404, 'NOT_FOUND', t('贴纸不存在'))
      if (Object.values(value).some((field) => field !== undefined)) db.update(table).set(value).where(condition).run()
      return c.json(listStickers(id))
    })
    app.delete(path, (c) => {
      const id = c.req.param('id')
      accountRow(id)
      db.delete(table)
        .where(and(eq(table.id, c.req.param('stickerId')), eq(table.accountId, id)))
        .run()
      return c.json(listStickers(id))
    })
  }
}
