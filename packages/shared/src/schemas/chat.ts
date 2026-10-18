import { z } from 'zod'
import { autoBackgroundSettingsSchema } from './background'
import type { GroupDTO } from './group'
import type { MessageDTO } from './message'
import type { StageState, StateSchema } from './stage'

export interface ChatSummary {
  id: string
  /** 单人会话的角色；群聊为 null */
  characterId: string | null
  /** 群聊的群组；单人会话为 null */
  groupId: string | null
  title: string
  updatedAt: number
}

export interface ChatDTO extends ChatSummary {
  quickReplySetIds?: string[]
  profileId: string | null
  personaId: string | null
  activeLeafId: string | null
  /** 连接配置，为空则用全局默认 */
  apiPresetId: string | null
  /** 生成预设，为空则用全局默认 */
  promptPresetId: string | null
  authorNote: string
  authorNoteDepth: number
  authorNoteRole: 'system' | 'user' | 'assistant'
  /** 挂在这个会话上的世界书 */
  lorebookIds: string[]
  /** 聊天背景（背景库里的 id），为空则用全局背景 */
  backgroundId: string | null
  /** 固定聊天背景：为 true 且有聊天背景时，它优先于舞台背景（用户手动覆盖模型选的场景） */
  backgroundPinned: boolean
  autoBackground: { lore: boolean; everyN: number }
  /** 玩法预设（VN 模式），为空则用角色卡指定的预设或全局默认 */
  playPresetId: string | null
  createdAt: number
}

/** 打开会话时返回的数据：会话信息 + 激活路径上的一页消息 */
export interface ChatPage {
  chat: ChatDTO
  /** 群聊时附带群组信息 */
  group: GroupDTO | null
  /** 按从旧到新排列 */
  messages: MessageDTO[]
  /** 更早的消息是否还有 */
  hasMore: boolean
  /** 当前会话是否有正在进行的生成 */
  generating: boolean
  /** 会话变量（跑团状态）= 初始值（[InitVar]、状态 schema 的 init）+ 沿激活路径累加的 varsPatch */
  vars: Record<string, unknown>
  /** 沿激活路径累加舞台指令得到的当前舞台；玩法预设没开指令时为 null */
  stage: StageState | null
  /** 实际生效的玩法预设 id（会话指定 > 角色卡指定 > 默认） */
  playPresetId: string
  /** 生效的状态定义（玩法预设和角色卡按「状态 schema 来源」合并后的），HUD 按它显示；没开指令时为空对象 */
  stateSchema: StateSchema
}

export const createChatInput = z
  .object({
    characterId: z.string().optional(),
    groupId: z.string().optional(),
    /** 单人会话用第几个开场白：0 是 first_mes，1 起是 alternate_greetings */
    greetingIndex: z.number().int().min(0).default(0),
  })
  .refine((v) => !!v.characterId !== !!v.groupId, '必须且只能指定角色或群组之一')
export type CreateChatInput = z.input<typeof createChatInput>

export const updateChatInput = z.object({
  quickReplySetIds: z.array(z.string()).optional(),
  profileId: z.string().nullable().optional(),
  title: z.string().trim().min(1).optional(),
  personaId: z.string().nullable().optional(),
  apiPresetId: z.string().nullable().optional(),
  promptPresetId: z.string().nullable().optional(),
  authorNote: z.string().optional(),
  authorNoteDepth: z.number().int().min(0).optional(),
  authorNoteRole: z.enum(['system', 'user', 'assistant']).optional(),
  lorebookIds: z.array(z.string()).optional(),
  backgroundId: z.string().nullable().optional(),
  backgroundPinned: z.boolean().optional(),
  autoBackground: autoBackgroundSettingsSchema.optional(),
  playPresetId: z.string().nullable().optional(),
})
export type UpdateChatInput = z.infer<typeof updateChatInput>

/**
 * 发起生成：
 * - send：先插入用户消息，再生成回复（text 为空时用预设里的「空消息替代文本」）
 * - regenerate：在 targetId 的父节点下生成一个新的 swipe
 * - continue：接着 targetId（必须是当前叶子上的角色回复）往下写
 * - trigger：不发用户消息，直接让角色发言；群聊里可以指定 speakerId（强制发言）
 */
export const generateInput = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('send'),
    text: z.string(),
    /** 附带的图片：先通过 POST /api/attachments 上传拿到 id */
    images: z.array(z.string()).max(10).default([]),
  }),
  z.object({ mode: z.literal('regenerate'), targetId: z.string() }),
  z.object({ mode: z.literal('continue'), targetId: z.string() }),
  z.object({ mode: z.literal('trigger'), speakerId: z.string().optional() }),
])
export type GenerateInput = z.infer<typeof generateInput>

/** 左右切换 swipe */
export const swipeInput = z.object({
  messageId: z.string(),
  direction: z.union([z.literal(-1), z.literal(1)]),
})
export type SwipeInput = z.infer<typeof swipeInput>

/** 批量切换「排除于上下文」。后端会自动带上配对的工具调用 / 结果消息 */
export const excludeMessagesInput = z.object({
  messageIds: z.array(z.string()).min(1).max(2000),
  excluded: z.boolean(),
})
export type ExcludeMessagesInput = z.infer<typeof excludeMessagesInput>

/**
 * 上移 / 下移一条消息：不改原有路径，而是在原位置生成一条交换了顺序的新分支（见 docs/design/messages-memory.md 第 4 节）
 */
export const moveMessageInput = z.object({
  messageId: z.string(),
  direction: z.enum(['up', 'down']),
})
export type MoveMessageInput = z.infer<typeof moveMessageInput>

/** HUD 里手动改变量：POST /api/chats/:id/vars，返回 { vars }（改完后的整份变量）。值为 null 表示删除这个变量 */
export const setVarsInput = z.object({ set: z.record(z.string(), z.unknown()) })
export type SetVarsInput = z.infer<typeof setVarsInput>

/** 切到某个节点所在的分支：激活叶子设为这个节点子树里最新的叶子（规则同 swipe） */
export const activateMessageInput = z.object({
  messageId: z.string(),
  /** true：激活叶子就是这条消息本身（读档用：从存档那一刻接着玩，后面的内容保留为另一条分支） */
  exact: z.boolean().optional(),
})
export type ActivateMessageInput = z.infer<typeof activateMessageInput>

/** 从某条消息开分支：复制到这条为止的路径，成为一个新会话 */
export const branchInput = z.object({ messageId: z.string() })
