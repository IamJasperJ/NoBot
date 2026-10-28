import { z } from 'zod'

export const telegramStickerSchema = z.object({
  file_id: z.string(),
  file_unique_id: z.string(),
  emoji: z.string().optional(),
  set_name: z.string().optional(),
  type: z.enum(['regular', 'mask', 'custom_emoji']).default('regular'),
  is_animated: z.boolean().default(false),
  is_video: z.boolean().default(false),
  thumbnail: z.object({ file_id: z.string() }).optional(),
})
export type TelegramSticker = z.infer<typeof telegramStickerSchema>

// NapCat 的 KCUSTOM=1、KHOT=2 属于表情图片，KNORMAL=0 保留普通图片流程。
// https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-core/types/msg.ts
export const QQ_STICKER_SUBTYPES = [1, 2] as const
export const isQqStickerSubtype = (value: unknown) => QQ_STICKER_SUBTYPES.some((subtype) => subtype === Number(value))

/** NapCat 把收到的商城表情编码为 image，重发时仍须还原为 mface。 */
// https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/api/msg.ts#L247-L268
export function isQqMarketFace(segment: { type: string; data: Record<string, unknown> }) {
  return (
    (segment.type === 'mface' || segment.type === 'image') &&
    ['emoji_package_id', 'emoji_id', 'key'].every(
      (key) => typeof segment.data[key] === 'string' || typeof segment.data[key] === 'number',
    )
  )
}
export function isQqNativeSticker(segment: { type: string; data: Record<string, unknown> }) {
  return (
    segment.type === 'mface' ||
    isQqMarketFace(segment) ||
    (segment.type === 'image' && isQqStickerSubtype(segment.data.sub_type))
  )
}
