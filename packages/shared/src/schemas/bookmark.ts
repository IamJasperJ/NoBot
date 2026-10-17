import { z } from 'zod'
import type { MessageRole } from './message'

/**
 * 书签：会话里某个消息节点的命名指针（酒馆的「检查点」，但不复制聊天——我们的会话本身就是树）。
 * 消息被删除（包括作为子树的一部分）、会话被删除时，书签一起删除
 */
export interface BookmarkDTO {
  id: string
  /** bookmark：普通书签；save：VN 存档（带舞台快照，用来画存档缩略图） */
  kind: 'bookmark' | 'save'
  /** 存档时的舞台快照；普通书签为 null */
  snapshot: SaveSnapshot | null
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

/** 存档时的舞台快照（存档列表里画缩略图、显示场景和摘要） */
export interface SaveSnapshot {
  /** 当时的背景（舞台匹配到的背景优先，其次会话背景）；没有为 null */
  backgroundUrl: string | null
  /** 台上的演员（最多 3 个，说话人 / 最后说话的人在前），立绘按当时的表情挑好 */
  actors: { name: string; characterId: string | null; spriteUrl: string | null; avatarUrl: string | null }[]
  place: string | null
  time: string | null
  /** 存档那条消息的摘要（去掉舞台指令，前 60 个字） */
  text: string
  /** HUD 里常驻（pin）的变量，存档时的值：[显示名, 值的文字] */
  vars: [string, string][]
}

/** VN 存档：POST /api/chats/:id/saves。messageId 不传 = 当前激活叶子；name 不传 = 「存档 n」+ 场景名 */
export const createSaveInput = z.object({
  messageId: z.string().optional(),
  name: z.string().trim().max(60).optional(),
})
export type CreateSaveInput = z.infer<typeof createSaveInput>

export const createBookmarkInput = z.object({
  messageId: z.string(),
  /** 不填时用消息正文前 20 个字（按 Array.from 计数，去掉换行）；正文为空时用「书签 n」 */
  name: z.string().trim().max(60).optional(),
})
export type CreateBookmarkInput = z.infer<typeof createBookmarkInput>

export const updateBookmarkInput = z.object({ name: z.string().trim().min(1).max(60) })
export type UpdateBookmarkInput = z.infer<typeof updateBookmarkInput>
