import type { RoomDTO, RoomRole } from '@nobot/shared'
import { create } from 'zustand'
import { useRooms } from '../../api/rooms'
import { t } from '../../i18n'

/** 房间相关弹窗的开关：管理房间、为某个会话开启联机、入房大厅 */
export const useRoomDialogs = create<{
  manageRoomId: string | null
  manageTab: RoomTab
  createForChatId: string | null
  lobbyInvite: string | null
  openManage: (roomId: string, tab?: RoomTab) => void
  openCreate: (chatId: string) => void
  openLobby: (invite: string) => void
  close: () => void
}>((set) => ({
  manageRoomId: null,
  manageTab: 'members',
  createForChatId: null,
  lobbyInvite: null,
  openManage: (manageRoomId, manageTab = 'members') => set({ manageRoomId, manageTab }),
  openCreate: (createForChatId) => set({ createForChatId }),
  openLobby: (lobbyInvite) => set({ lobbyInvite }),
  close: () => set({ manageRoomId: null, createForChatId: null, lobbyInvite: null }),
}))
export type RoomTab = 'members' | 'invite' | 'me' | 'characters' | 'sessions' | 'initiative' | 'settings'

/** 只读查找：这个会话是不是联机房间。订阅和作用域由 ChatView 里的 useRoomForChat 负责 */
export function useRoomInfo(chatId: string | null): RoomDTO | undefined {
  return useRooms().data?.find((r) => r.chatId === chatId)
}

export const roleLabel = (): Record<RoomRole, string> => ({
  owner: t('房主'),
  gm: t('主持'),
  player: t('玩家'),
  spectator: t('旁观者'),
})
export const turnModeLabel = (): Record<RoomDTO['turnMode'], string> => ({
  smart: t('智能接话'),
  auto: t('自动回应'),
  mention: t('点名才回'),
  host: t('主持收束'),
  initiative: t('先攻顺序'),
})
export const turnModeHint = (): Record<RoomDTO['turnMode'], string> => ({
  smart: t('被叫到、被提问时马上接话；大家聊得热闹时不插嘴，冷场或话题相关时再开口'),
  auto: t('有人发言后安静几秒，AI 把这几秒里所有人的话一起回应'),
  mention: t('只有 @ 或叫到角色名字时才回应'),
  host: t('大家自由发言，由房主或主持点「让 AI 回应」'),
  initiative: t('按先攻顺序行动，主持可以跳过或调整顺序'),
})
export const modeLabel = (): Record<RoomDTO['mode'], string> => ({
  chat: t('陪聊'),
  trpg: t('跑团'),
  custom: t('自定义'),
})
export const ratingLabel = (): Record<RoomDTO['contentRating'], string> => ({
  general: t('一般'),
  mature: t('成人'),
  explicit: t('露骨'),
})
export const ratingClass: Record<RoomDTO['contentRating'], string> = {
  general: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
  mature: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  explicit: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
}

/** 「A」「A 和 B」「A、B 等 3 人」 */
export function namesText(names: string[]) {
  if (names.length === 1) return names[0] as string
  if (names.length === 2) return t('{a} 和 {b}', { a: names[0] as string, b: names[1] as string })
  return t('{a}、{b} 等 {n} 人', { a: names[0] as string, b: names[1] as string, n: names.length })
}

/** 房间里非公开消息的标记文字：主持可见 / 暗骰 / 仅自己可见 / 私信给谁 */
export function privacyLabel(
  meta: { visibility?: { level: string; userIds: string[] }; hidden?: { reason: string }; author?: { userId: string } },
  room: RoomDTO | undefined,
) {
  if (meta.hidden) return meta.hidden.reason === 'whisper' ? t('私信') : t('暗骰')
  const v = meta.visibility
  if (!v || v.level === 'public') return null
  if (v.level === 'gm') return t('主持可见')
  if (v.level === 'blind') return t('暗骰')
  if (v.level === 'self') return t('仅自己可见')
  const others = v.userIds.filter((id) => id !== meta.author?.userId)
  const names = others.map((id) => room?.members.find((m) => m.userId === id)?.personaName).filter(Boolean)
  return names.length ? t('私信 → {names}', { names: names.join('、') }) : t('私信')
}

export const choiceModeLabel = (): Record<RoomDTO['choiceMode'], string> => ({
  gm: t('房主或主持决定'),
  vote: t('全队投票'),
  each: t('各自选择'),
})
export const choiceModeHint = (): Record<RoomDTO['choiceMode'], string> => ({
  gm: t('只有房主和主持能点剧情选项'),
  vote: t('每人一票，多数决定；平票由主持定，超时自动结束'),
  each: t('每个玩家各选各的，AI 一起回应所有人的选择'),
})
