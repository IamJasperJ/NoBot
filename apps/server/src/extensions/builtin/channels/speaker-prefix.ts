import type { ChannelAccountConfig, ChannelBindingDTO, MessageDTO } from '@nobot/shared'
import { stageMembers } from '../../../services/generation/stage'

/** 平台群与角色群是两回事；只有多个角色需要名字消歧，网页人设镜像仍保留名字。 */
export function omitSpeakerPrefix(
  binding: ChannelBindingDTO,
  message: MessageDTO,
  accountId: string,
  identity: Pick<ChannelAccountConfig, 'characterMode' | 'characterId'>,
) {
  return (
    message.role === 'assistant' &&
    (stageMembers(binding.chatId).length <= 1 ||
      (!!message.speakerId && binding.speakers[message.speakerId] === accountId) ||
      (identity.characterMode === 'fixed' && !!identity.characterId && message.speakerId === identity.characterId))
  )
}
