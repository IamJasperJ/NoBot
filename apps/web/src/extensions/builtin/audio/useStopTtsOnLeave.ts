import { useEffect } from 'react'
import { ttsPlayer } from './tts-player'

// 每次进入视图都使用独立身份，切走再回来也不能恢复上次的自动朗读请求。
let visibleChat: { chatId: string } | null = null

export function getVisibleTtsChat() {
  return visibleChat
}

export function useStopTtsOnLeave(chatId: string) {
  useEffect(() => {
    const view = { chatId }
    visibleChat = view
    return () => {
      if (visibleChat === view) visibleChat = null
      ttsPlayer.stopChat(chatId)
    }
  }, [chatId])
}
