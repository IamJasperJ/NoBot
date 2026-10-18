import { create } from 'zustand'

/** 按会话保留草稿，让命令和自动执行都能读写当前输入。 */
export const useCommandDrafts = create<{
  drafts: Record<string, string>
  set: (chatId: string, text: string) => void
}>((set) => ({ drafts: {}, set: (chatId, text) => set((s) => ({ drafts: { ...s.drafts, [chatId]: text } })) }))
