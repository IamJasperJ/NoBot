import { z } from 'zod'
import type { MessageRole } from './message'

/**
 * 书签：会话里某个消息节点的命名指针（酒馆的「检查点」，但不复制聊天——我们的会话本身就是树）。
 * 消息被删除（包括作为子树的一部分）、会话被删除时，书签一起删除
 */
export interface BookmarkDTO {
  id: string
  chatId: string
  messageId: string
  name: string
  createdAt: number
  /** 指向的消息摘要，列表里显示 */
  preview: {
    role: MessageRole
    /** 发言人名字（同消息列表的规则：人设名 / 角色名 / meta.name） */
    name: string
    /** 正文前 60 个字（按 Array.from 计数），超出加「…」；纯图片消息为「（图片）」 */
    text: string
  }
  /** 这条消息是否在当前激活路径上（不在时，跳转前要先切换分支） */
  onPath: boolean
}

export const createBookmarkInput = z.object({
  messageId: z.string(),
  /** 不填时用消息正文前 20 个字（按 Array.from 计数，去掉换行）；正文为空时用「书签 n」 */
  name: z.string().trim().max(60).optional(),
})
export type CreateBookmarkInput = z.infer<typeof createBookmarkInput>

export const updateBookmarkInput = z.object({ name: z.string().trim().min(1).max(60) })
export type UpdateBookmarkInput = z.infer<typeof updateBookmarkInput>
