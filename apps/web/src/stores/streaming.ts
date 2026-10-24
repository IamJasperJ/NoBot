import { create } from 'zustand'

interface Stream {
  messageId: string
  text: string
  reasoning: string
}
interface StreamingState {
  /** 兼容现有单人组件；新组件按 streams[chatId] 订阅。 */
  chatId: string | null
  messageId: string | null
  text: string
  reasoning: string
  streams: Record<string, Stream>
  begin: (chatId: string, messageId: string, initial?: string) => void
  append: (text: string, reasoning: string, chatId?: string) => void
  end: (chatId?: string) => void
}
export const useStreaming = create<StreamingState>((set) => ({
  chatId: null,
  messageId: null,
  text: '',
  reasoning: '',
  streams: {},
  begin: (chatId, messageId, initial = '') =>
    set((s) => ({
      chatId,
      messageId,
      text: initial,
      reasoning: '',
      streams: { ...s.streams, [chatId]: { messageId, text: initial, reasoning: '' } },
    })),
  append: (text, reasoning, chatId) =>
    set((s) => {
      const id = chatId ?? s.chatId
      if (!id || !s.streams[id]) return s
      const stream = {
        ...s.streams[id],
        text: s.streams[id].text + text,
        reasoning: s.streams[id].reasoning + reasoning,
      }
      return { streams: { ...s.streams, [id]: stream }, ...(s.chatId === id ? stream : {}) }
    }),
  end: (chatId) =>
    set((s) => {
      const id = chatId ?? s.chatId
      const streams = { ...s.streams }
      if (id) delete streams[id]
      const next = s.chatId === id ? (Object.keys(streams).at(-1) ?? null) : s.chatId
      return { streams, chatId: next, ...(next ? streams[next]! : { messageId: null, text: '', reasoning: '' }) }
    }),
}))
