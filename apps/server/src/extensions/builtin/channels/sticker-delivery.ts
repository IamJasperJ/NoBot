import { createHash } from 'node:crypto'
import type { ChannelBindingDTO, MessageDTO } from '@nobot/shared'
import { eq } from 'drizzle-orm'
import { db, getSetting, setSetting } from '../../../db/client'
import { channelStickers } from '../../../db/schema'
import { OneBotClient } from './adapters/onebot11/client'
import type { ChannelClient } from './adapters/types'
import { cachedStickerFile, usableStickers } from './stickers'
import { accountRow } from './store'

/** 由 ChannelService 在正文之后（工具调用位置）排队；私密投递必须先完成房间收件人投影。 */
export async function sendMessageStickers(binding: ChannelBindingDTO, message: MessageDTO, client: ChannelClient) {
  if (
    message.meta.hidden ||
    message.meta.channel === 'whisper' ||
    (message.meta.visibility && message.meta.visibility.level !== 'public')
  )
    return
  const platform = accountRow(binding.accountId).config.provider
  for (const [index, sticker] of (message.meta.stickers ?? []).entries()) {
    if (sticker.platform !== platform || (sticker.accountId && sticker.accountId !== binding.accountId)) continue
    // 排队后仍重查开关/专属权限，主人撤销的表情不再投递。
    const usable = usableStickers(binding.accountId, message.speakerId ?? undefined).find(
      (entry) => JSON.stringify(entry.ref) === JSON.stringify(sticker.ref),
    )
    if (!usable) continue
    const key = `channels:sticker-delivery:${createHash('sha256')
      .update(JSON.stringify([binding.id, binding.chat, message.id, index]))
      .digest('hex')}`
    if (getSetting(key)) continue
    const ref = sticker.ref
    await client.serialized(binding.chat, async () => {
      if (getSetting(key)) return
      if (client instanceof OneBotClient) {
        if (ref.kind === 'telegram') return
        // NapCat 保留 sub_type 才按表情显示；mface 必须重放原来的包 id、表情 id 与 key。
        // https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/api/msg.ts
        const entry =
          ref.kind === 'image'
            ? db.select().from(channelStickers).where(eq(channelStickers.id, usable.id)).get()
            : undefined
        const file = entry ? cachedStickerFile(entry) : undefined
        const image = file ? `base64://${Buffer.from(await file.arrayBuffer()).toString('base64')}` : undefined
        const segment =
          ref.kind === 'face'
            ? { type: 'face', data: { id: ref.id } }
            : ref.kind === 'mface'
              ? {
                  type: 'mface',
                  data: {
                    emoji_package_id: ref.emoji_package_id,
                    emoji_id: ref.emoji_id,
                    key: ref.key,
                    summary: ref.summary,
                  },
                }
              : { type: 'image', data: { file: image ?? ref.url, sub_type: ref.sub_type, summary: ref.summary } }
        await client.send(binding.chat.replace(/^-/, ''), [segment], binding.scope)
      } else {
        if (ref.kind !== 'telegram' || ref.type === 'custom_emoji') return
        // file_unique_id 只能去重，sendSticker 必须使用本账号的 file_id。
        // https://core.telegram.org/bots/api#sendsticker
        await client.call('sendSticker', {
          chat_id: binding.chat,
          message_thread_id: binding.thread || undefined,
          sticker: ref.file_id,
        })
      }
      setSetting(key, true)
    })
  }
}
