/**
 * 回收站：删除角色 / 群组时先软删除（deleted_at），在回收站里可以恢复或彻底删除。
 * 只有彻底删除才会级联删除它们的会话、消息、头像和立绘文件。
 *
 * 接口：
 * - GET    /api/characters/:id/usage            → UsageDTO（删除前提醒用）
 * - GET    /api/groups/:id/usage                → UsageDTO
 * - DELETE /api/characters/:id、/api/groups/:id → 移进回收站（原来的删除接口，行为改成软删除）
 * - GET    /api/trash                           → TrashDTO
 * - POST   /api/trash/characters/:id/restore、/api/trash/groups/:id/restore → { ok: true }
 * - DELETE /api/trash/characters/:id、/api/trash/groups/:id                 → 彻底删除 { ok: true }
 * - DELETE /api/trash                           → 清空回收站 { deleted: number }
 */

export interface UsageDTO {
  /** 属于它的会话数（角色：单聊会话；群组：群聊会话） */
  chats: number
  /** 角色所在的群组（未删除的）；群组的 usage 里为空数组 */
  groups: { id: string; name: string }[]
}

export interface TrashItemDTO {
  id: string
  kind: 'character' | 'group'
  name: string
  avatarUrl: string | null
  deletedAt: number
  /** 跟着它一起进回收站（恢复时一起回来）的会话数 */
  chats: number
}

export interface TrashDTO {
  /** 按删除时间倒序 */
  items: TrashItemDTO[]
}
