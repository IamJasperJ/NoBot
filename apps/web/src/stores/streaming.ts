import { create } from 'zustand'

/**
 * 正在生成的那条消息的文本，单独放在这里而不是放进 Query 缓存。
 * 只有正在生成的那条消息的组件订阅它，其他消息不会跟着重新渲染。
 */
interface StreamingState {
  chatId: string | null
  messageId: string | null
  text: string
  reasoning: string
  begin: (chatId: string, messageId: string) => void
  append: (text: string, reasoning: string) => void
  end: () => void
}

export const useStreaming = create<StreamingState>((set) => ({
  chatId: null,
  messageId: null,
  text: '',
  reasoning: '',
  begin: (chatId, messageId) => set({ chatId, messageId, text: '', reasoning: '' }),
  append: (text, reasoning) => set((s) => ({ text: s.text + text, reasoning: s.reasoning + reasoning })),
  end: () => set({ chatId: null, messageId: null, text: '', reasoning: '' }),
}))
