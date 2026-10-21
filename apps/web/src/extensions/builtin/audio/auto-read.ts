import { speechSegments } from '@nobot/core/stage'
import type { ChatVoiceDTO, MessageDTO } from '@nobot/shared'
import { ttsPlayer } from './tts-player'

/** 同一轮的完整回复和流式分段共用一个播放器队列，位置记录的是已提交的分段。 */
export class AutoReader {
  private positions = new Map<string, number>()
  private completed = new Set<string>()

  read(chatId: string, message: MessageDTO, members: ChatVoiceDTO['members'], streaming: boolean, streamRead: boolean) {
    const key = `${chatId}:${message.id}#${message.swipeIndex}`
    if (this.completed.has(key) || (streaming && !streamRead)) return
    const position = this.positions.get(key)
    if (!streaming && position === undefined) {
      this.completed.add(key)
      ttsPlayer.enqueueMessage(chatId, message.id)
      return
    }
    const segments = speechSegments(message, members, streaming)
    for (const segment of segments.slice(position ?? 0)) ttsPlayer.enqueueLine(chatId, segment)
    this.positions.set(key, segments.length)
    if (!streaming) this.completed.add(key)
  }
}
