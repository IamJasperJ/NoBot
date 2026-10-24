import type { ChannelBindingDTO } from '@nobot/shared'
import { getSetting, setSetting } from '../../../db/client'
import type { TelegramClient } from './adapters/telegram/client'
import type { ChannelService } from './service'

/** 轻互动只做确认收到，不把模型输出解释为社交管理命令。预算按账号和 UTC 日持久化。 */
export async function reactToMessage(
  service: ChannelService,
  binding: ChannelBindingDTO,
  actor: string,
  messageId: number,
  client: TelegramClient,
  now = Date.now(),
) {
  const settings = service.settings(binding).values
  if (!settings.reactions) return
  const key = `channels:reaction:${binding.accountId}`
  const day = Math.floor(now / 86400000)
  const previous = getSetting<{ day: number; count: number; last: Record<string, number> }>(key)
  const state = previous?.day === day ? previous : { day, count: 0, last: {} }
  if (
    state.count >= settings.reactionDailyBudget ||
    (state.last[actor] !== undefined && now - state.last[actor]! < settings.reactionCooldownMs)
  )
    return
  state.count++
  state.last[actor] = now
  setSetting(key, state)
  await client.call('setMessageReaction', {
    chat_id: binding.chat,
    message_id: messageId,
    reaction: [{ type: 'emoji', emoji: '👍' }],
  })
}
