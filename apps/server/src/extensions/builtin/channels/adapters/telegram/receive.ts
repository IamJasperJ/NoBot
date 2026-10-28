import { z } from 'zod'
import { telegramStickerSchema } from '../../sticker-types'

const user = z.object({
  id: z.number().int(),
  is_bot: z.boolean().optional(),
  first_name: z.string().default(''),
  last_name: z.string().optional(),
  username: z.string().optional(),
})
const chat = z.object({
  id: z.number().int(),
  type: z.enum(['private', 'group', 'supergroup', 'channel']),
  title: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
})
const media = z.object({
  file_id: z.string().optional(),
  file_size: z.number().optional(),
  mime_type: z.string().optional(),
  duration: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
})
const message = z.object({
  message_id: z.number().int(),
  chat,
  from: user.optional(),
  text: z.string().optional(),
  message_thread_id: z.number().int().optional(),
  entities: z
    .array(z.object({ type: z.string(), offset: z.number(), length: z.number(), user: user.optional() }))
    .default([]),
  reply_to_message: z.object({ message_id: z.number(), from: user.optional() }).optional(),
  forum_topic_created: z.object({ name: z.string() }).optional(),
  forum_topic_edited: z.object({ name: z.string().optional() }).optional(),
  new_chat_title: z.string().optional(),
  caption: z.string().optional(),
  media_group_id: z.string().optional(),
  photo: z.array(media).optional(),
  voice: media.optional(),
  audio: media.optional(),
  video_note: media.optional(),
  document: media.optional(),
  sticker: telegramStickerSchema.partial().optional(),
  nativeStickers: z.array(z.object({ type: z.string(), data: z.record(z.string(), z.unknown()) })).optional(),
})
const membership = z.object({
  chat,
  from: user,
  old_chat_member: z.object({ status: z.string() }),
  new_chat_member: z.object({ status: z.string() }),
})
const updateSchema = z.object({
  update_id: z.number().int(),
  managed_bot: z.object({ user, bot: user }).optional(),
  message: message.optional(),
  edited_message: message.optional(),
  callback_query: z
    .object({ id: z.string(), from: user, data: z.string().optional(), message: message.optional() })
    .optional(),
  my_chat_member: membership.optional(),
  chat_member: membership.optional(),
  message_reaction: z
    .object({ chat, message_id: z.number(), user: user.optional(), new_reaction: z.array(z.unknown()) })
    .optional(),
})
export function decodeTelegram(input: unknown, bot: { id?: string | null; username?: string | null }) {
  const result = updateSchema.safeParse(input)
  if (!result.success) return null
  const update = result.data
  if (update.managed_bot)
    return { type: 'managed_bot' as const, dedupeKey: String(update.update_id), ...update.managed_bot }
  const member = update.my_chat_member ?? update.chat_member
  if (member)
    return {
      type: update.my_chat_member ? ('membership' as const) : ('member' as const),
      dedupeKey: String(update.update_id),
      ...member,
    }
  const callback = update.callback_query
  if (callback) return { type: 'callback' as const, dedupeKey: String(update.update_id), ...callback }
  if (update.message_reaction)
    return { type: 'reaction' as const, dedupeKey: String(update.update_id), ...update.message_reaction }
  const msg = update.message ?? update.edited_message
  if (!msg?.from || msg.chat.type === 'channel') return null
  if (
    (msg.from.is_bot || String(msg.from.id) === bot.id) &&
    !(msg.forum_topic_created || msg.forum_topic_edited || msg.new_chat_title)
  )
    return null
  const text = msg.text ?? msg.caption ?? (msg.sticker ? `[sticker: ${msg.sticker.emoji ?? ''}]` : '')
  const match = /^\/([a-z_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(text)
  if (match?.[2] && match[2].toLowerCase() !== bot.username?.toLowerCase()) return null
  return {
    type: update.edited_message ? ('edit' as const) : ('message' as const),
    dedupeKey: String(update.update_id),
    ...msg,
    from: msg.from,
    displayName: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' '),
    text,
    command: match ? { name: match[1]!.toLowerCase(), args: match[3] ?? '' } : null,
    mentionsBot: msg.entities.some(
      (e) =>
        (e.type === 'mention' &&
          text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${bot.username?.toLowerCase()}`) ||
        (e.type === 'text_mention' && String(e.user?.id) === bot.id),
    ),
    repliesToBot: String(msg.reply_to_message?.from?.id) === bot.id,
    unsupportedMedia: !!(msg.photo || msg.voice || msg.audio),
  }
}
export type TelegramEvent = NonNullable<ReturnType<typeof decodeTelegram>>
export function verifyWebhookSecret(actual: string | undefined, expected: string) {
  if (!actual || !expected || actual.length !== expected.length) return false
  let difference = 0
  for (let i = 0; i < actual.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i)
  return difference === 0
}
