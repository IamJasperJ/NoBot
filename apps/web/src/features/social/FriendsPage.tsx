import type { FriendDTO, NotificationDTO, PresenceStatus, PublicUserDTO } from '@nobot/shared'
import { type FormEvent, useState } from 'react'
import { useLiveStore } from '../../api/live'
import { roomNotificationText, useRooms } from '../../api/rooms'
import {
  useBlocks,
  useBlockUser,
  useDismissNotification,
  useFriends,
  useNotifications,
  usePresencePreference,
  useReadNotifications,
  useRemoveFriend,
  useRequestFriend,
  useRespondFriend,
  useUnblockUser,
} from '../../api/social'
import { BanIcon, CheckIcon, TrashIcon, UserPlusIcon, XIcon } from '../../components/icons'
import { Menu, MenuDivider, MenuEntry } from '../../components/menu'
import { Avatar, Button, badgeClass, cx, IconButton, inputClass } from '../../components/ui'
import { getLanguage, t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { modeLabel, ratingClass, ratingLabel, roleLabel, useRoomDialogs } from '../rooms/shared'

type Tab = 'rooms' | 'friends' | 'requests' | 'notifications' | 'blocks'

const presenceLabel = (): Record<PresenceStatus, string> => ({
  online: t('在线'),
  away: t('离开'),
  dnd: t('请勿打扰'),
  offline: t('离线'),
})
const presenceDot: Record<PresenceStatus, string> = {
  online: 'bg-green-500',
  away: 'bg-amber-400',
  dnd: 'bg-red-500',
  offline: 'bg-zinc-300 dark:bg-zinc-600',
}
const presenceOrder: Record<PresenceStatus, number> = { online: 0, dnd: 1, away: 2, offline: 3 }
const time = (at: number) =>
  new Date(at).toLocaleString(getLanguage() === 'en' ? 'en-US' : 'zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

/** 失败统一弹提示；成功的提示由调用方决定 */
const run = (p: Promise<unknown>, done?: string) =>
  p.then(
    () => done && toast.info(done),
    (e: unknown) => toast.error(errorMessage(e)),
  )

/** 头像右下角的在线状态点 */
function PresenceAvatar({ user, status }: { user: PublicUserDTO; status?: PresenceStatus }) {
  return (
    <span className="relative shrink-0">
      <Avatar name={user.name} size={36} />
      {status && (
        <span
          title={presenceLabel()[status]}
          className={cx(
            'absolute right-0 bottom-0 size-3 rounded-full ring-2 ring-white dark:ring-zinc-950',
            presenceDot[status],
          )}
        />
      )}
    </span>
  )
}

function UserLine({ user, sub }: { user: PublicUserDTO; sub?: string }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-medium">{user.name}</span>
      <span className="block truncate text-xs text-zinc-500">
        @{user.handle}
        {sub && ` · ${sub}`}
      </span>
    </span>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-800/60">
      {children}
    </li>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="px-2 py-8 text-center text-sm text-zinc-500">{text}</p>
}

function AddFriend() {
  const [handle, setHandle] = useState('')
  const request = useRequestFriend()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const value = handle.trim().replace(/^@/, '')
    if (!value) return
    void run(request.mutateAsync(value), t('已发送好友请求')).then(() => setHandle(''))
  }
  return (
    <form onSubmit={submit} className="flex gap-2">
      <input
        value={handle}
        onChange={(e) => setHandle(e.target.value)}
        placeholder={t('输入对方的用户名添加好友')}
        aria-label={t('用户名')}
        className={cx(inputClass, 'h-9 min-w-0 flex-1 py-0')}
      />
      <Button type="submit" variant="primary" disabled={!handle.trim() || request.isPending}>
        <UserPlusIcon />
        <span className="ml-1.5">{t('添加')}</span>
      </Button>
    </form>
  )
}

function FriendList({ friends }: { friends: FriendDTO[] }) {
  const live = useLiveStore((s) => s.presence)
  const remove = useRemoveFriend()
  const block = useBlockUser()
  if (!friends.length) return <Empty text={t('还没有好友。输入对方的用户名发送请求')} />
  const status = (f: FriendDTO) => (live[f.id] ?? f.presence).status
  const sorted = [...friends].sort(
    (a, b) => presenceOrder[status(a)] - presenceOrder[status(b)] || a.name.localeCompare(b.name),
  )
  return (
    <ul>
      {sorted.map((f) => {
        const presence = live[f.id] ?? f.presence
        return (
          <Row key={f.id}>
            <PresenceAvatar user={f} status={presence.status} />
            <UserLine
              user={f}
              sub={
                presence.currentRoom
                  ? t('在「{room}」', { room: presence.currentRoom.name })
                  : presenceLabel()[presence.status]
              }
            />
            <Menu>
              <MenuEntry
                icon={<TrashIcon />}
                onClick={() => void run(remove.mutateAsync(f.id), t('已删除好友「{name}」', { name: f.name }))}
              >
                {t('删除好友')}
              </MenuEntry>
              <MenuDivider />
              <MenuEntry
                danger
                icon={<BanIcon />}
                onClick={() => void run(block.mutateAsync(f.id), t('已拉黑「{name}」', { name: f.name }))}
              >
                {t('拉黑')}
              </MenuEntry>
            </Menu>
          </Row>
        )
      })}
    </ul>
  )
}

function Requests() {
  const friends = useFriends()
  const respond = useRespondFriend()
  const incoming = friends.data?.incoming ?? []
  const outgoing = friends.data?.outgoing ?? []
  if (!incoming.length && !outgoing.length) return <Empty text={t('没有待处理的好友请求')} />
  return (
    <div className="space-y-4">
      {incoming.length > 0 && (
        <section>
          <h3 className="px-2 pb-1 text-xs font-medium text-zinc-500">{t('收到的请求')}</h3>
          <ul>
            {incoming.map((r) => (
              <Row key={r.user.id}>
                <PresenceAvatar user={r.user} />
                <UserLine user={r.user} sub={time(r.createdAt)} />
                <IconButton
                  label={t('接受')}
                  onClick={() =>
                    void run(
                      respond.mutateAsync({ userId: r.user.id, action: 'accept' }),
                      t('已添加「{name}」为好友', { name: r.user.name }),
                    )
                  }
                >
                  <CheckIcon />
                </IconButton>
                <IconButton
                  label={t('拒绝')}
                  variant="danger"
                  onClick={() => void run(respond.mutateAsync({ userId: r.user.id, action: 'reject' }))}
                >
                  <XIcon />
                </IconButton>
              </Row>
            ))}
          </ul>
        </section>
      )}
      {outgoing.length > 0 && (
        <section>
          <h3 className="px-2 pb-1 text-xs font-medium text-zinc-500">{t('发出的请求')}</h3>
          <ul>
            {outgoing.map((r) => (
              <Row key={r.user.id}>
                <PresenceAvatar user={r.user} />
                <UserLine user={r.user} sub={t('等待对方回应')} />
                <Button
                  size="sm"
                  onClick={() => void run(respond.mutateAsync({ userId: r.user.id, action: 'cancel' }))}
                >
                  {t('撤回')}
                </Button>
              </Row>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/** 通知的显示文字；未知类型（以后的房间邀请等）给一个通用说法 */
export function notificationText(n: NotificationDTO) {
  const actor = n.payload.actor as PublicUserDTO | undefined
  const name = actor?.name ?? t('有人')
  switch (n.type) {
    case 'friend.request':
      return t('{name} 想加你为好友', { name })
    case 'friend.accepted':
      return t('{name} 接受了你的好友请求', { name })
    case 'room.invite':
      return t('{name} 邀请你加入「{room}」', { name, room: String(n.payload.name ?? '') })
    case 'room.turn.request':
      return t('{name} 在「{room}」里请你让 AI 回应', { name, room: String(n.payload.name ?? '') })
    default:
      return roomNotificationText(n) ?? t('新通知')
  }
}

function Notifications() {
  const query = useNotifications()
  const read = useReadNotifications()
  const dismiss = useDismissNotification()
  const respond = useRespondFriend()
  const friends = useFriends()
  const rooms = useRooms()
  const items = query.data?.pages.flatMap((p) => p.items) ?? []
  const pending = new Set(friends.data?.incoming.map((r) => r.user.id))
  if (query.isPending) return <Empty text={t('加载中…')} />
  if (!items.length) return <Empty text={t('没有通知')} />
  return (
    <div>
      <div className="flex justify-end px-1 pb-1">
        <Button
          size="sm"
          disabled={!items.some((n) => !n.readAt)}
          onClick={() => void run(read.mutateAsync(undefined))}
        >
          {t('全部标为已读')}
        </Button>
      </div>
      <ul>
        {items.map((n) => {
          const actor = n.payload.actor as PublicUserDTO | undefined
          const canRespond = n.type === 'friend.request' && actor && pending.has(actor.id)
          return (
            <li
              key={n.id}
              className={cx(
                'group flex items-start gap-2.5 rounded-lg px-2 py-2',
                n.readAt ? 'opacity-70' : 'bg-violet-50 dark:bg-violet-950/40',
              )}
            >
              {actor ? <PresenceAvatar user={actor} /> : <Avatar name="!" size={36} />}
              <div className="min-w-0 flex-1">
                <p className="text-sm">{notificationText(n)}</p>
                <p className="text-xs text-zinc-500">{time(n.createdAt)}</p>
                {n.type === 'room.invite' && typeof n.payload.inviteId === 'string' && (
                  <div className="mt-2">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => useRoomDialogs.getState().openLobby(n.payload.inviteId as string)}
                    >
                      {t('查看邀请')}
                    </Button>
                  </div>
                )}
                {n.type === 'room.turn.request' &&
                  (() => {
                    const room = rooms.data?.find((r) => r.id === n.payload.roomId)
                    return room ? (
                      <div className="mt-2">
                        <Button size="sm" onClick={() => useUi.getState().openChat({}, room.chatId)}>
                          {t('去房间')}
                        </Button>
                      </div>
                    ) : null
                  })()}
                {canRespond && (
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() =>
                        void run(
                          respond.mutateAsync({ userId: actor.id, action: 'accept' }),
                          t('已添加「{name}」为好友', { name: actor.name }),
                        )
                      }
                    >
                      {t('接受')}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void run(respond.mutateAsync({ userId: actor.id, action: 'reject' }))}
                    >
                      {t('拒绝')}
                    </Button>
                  </div>
                )}
              </div>
              <IconButton
                label={t('移除通知')}
                className="opacity-100 md:opacity-0 md:group-hover:opacity-100"
                onClick={() => void run(dismiss.mutateAsync(n.id))}
              >
                <XIcon />
              </IconButton>
            </li>
          )
        })}
      </ul>
      {query.hasNextPage && (
        <div className="flex justify-center pt-2">
          <Button size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            {t('加载更多')}
          </Button>
        </div>
      )}
    </div>
  )
}

function Blocks() {
  const blocks = useBlocks()
  const unblock = useUnblockUser()
  const list = blocks.data ?? []
  if (!list.length) return <Empty text={t('黑名单是空的')} />
  return (
    <ul>
      {list.map((u) => (
        <Row key={u.id}>
          <PresenceAvatar user={u} />
          <UserLine user={u} />
          <Button size="sm" onClick={() => void run(unblock.mutateAsync(u.id), t('已解除拉黑'))}>
            {t('解除拉黑')}
          </Button>
        </Row>
      ))}
    </ul>
  )
}

/** 自己的在线状态：自动 / 请勿打扰 / 隐身 */
function MyStatus() {
  const pref = usePresencePreference()
  const [value, setValue] = useState<'auto' | 'dnd' | 'invisible'>('auto')
  const options = [
    { id: 'auto', label: t('自动'), dot: presenceDot.online },
    { id: 'dnd', label: t('请勿打扰'), dot: presenceDot.dnd },
    { id: 'invisible', label: t('隐身'), dot: presenceDot.offline },
  ] as const
  const current = options.find((o) => o.id === value) ?? options[0]
  return (
    <label className="relative inline-flex items-center">
      <span className={cx('pointer-events-none absolute left-2.5 size-2.5 rounded-full', current.dot)} />
      <select
        aria-label={t('我的状态')}
        value={value}
        onChange={(e) => {
          const next = e.target.value as typeof value
          setValue(next)
          void run(pref.mutateAsync(next))
        }}
        className="h-8 cursor-pointer appearance-none rounded-lg bg-transparent pr-2 pl-7 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** 侧栏很窄：四个等宽页签，文字放不下时截断，数量用小红点角标显示 */
function PanelTabs({
  value,
  onChange,
  tabs,
}: {
  value: Tab
  onChange: (tab: Tab) => void
  tabs: { id: Tab; label: string; badge?: number }[]
}) {
  return (
    <div role="tablist" className="grid grid-cols-4 gap-0.5 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          title={tab.label}
          onClick={() => onChange(tab.id)}
          className={cx(
            'relative flex min-w-0 items-center justify-center rounded-md px-0.5 py-1.5 text-xs font-medium',
            value === tab.id ? 'bg-white shadow-sm dark:bg-zinc-950' : 'text-zinc-500',
          )}
        >
          <span className="truncate">{tab.label}</span>
          {!!tab.badge && (
            // 角标挂在右上角，不占文字宽度，窄侧栏里英文标签也能完整显示
            <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] leading-none font-semibold text-white">
              {tab.badge > 99 ? '99+' : tab.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

/** 我所在的联机房间（我开的和我加入的） */
function RoomList() {
  const rooms = useRooms()
  const openChat = useUi((s) => s.openChat)
  const list = [...(rooms.data ?? [])].sort((a, b) => b.unreadCount - a.unreadCount || b.updatedAt - a.updatedAt)
  if (rooms.isPending) return <Empty text={t('加载中…')} />
  if (!list.length)
    return <Empty text={t('还没有房间。在会话输入框左边的「+」菜单里选「开启联机」，或者等好友邀请你')} />
  return (
    <ul>
      {list.map((room) => {
        const active = room.members.filter((m) => m.state === 'active')
        const online = active.filter((m) => m.inRoom).length
        return (
          <li key={room.id}>
            <button
              type="button"
              onClick={() => openChat({}, room.chatId)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
            >
              <Avatar name={room.name} size={36} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{room.name}</span>
                  {room.contentRating !== 'general' && (
                    <span className={cx(badgeClass, ratingClass[room.contentRating])}>
                      {ratingLabel()[room.contentRating]}
                    </span>
                  )}
                </span>
                <span className="block truncate text-xs text-zinc-500">
                  {roleLabel()[room.myRole]} · {modeLabel()[room.mode]} ·{' '}
                  {online
                    ? t('{online} / {count} 人在线', { online, count: active.length })
                    : t('{count} 人', { count: active.length })}
                </span>
              </span>
              {room.unreadCount > 0 && (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-semibold text-white">
                  {room.unreadCount > 99 ? '99+' : room.unreadCount}
                </span>
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** 侧栏「好友」面板：房间、好友、请求、通知；黑名单在右上角菜单里 */
export function FriendsPage() {
  const [tab, setTab] = useState<Tab>('rooms')
  const rooms = useRooms()
  const roomUnread = (rooms.data ?? []).reduce((sum, r) => sum + r.unreadCount, 0)
  const friends = useFriends()
  const unread = useLiveStore((s) => s.unreadCount)
  const setSidebarOpen = useUi((s) => s.setSidebarOpen)
  const incoming = friends.data?.incoming.length ?? 0
  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 px-3">
        <h1 className="flex-1 truncate font-semibold">{t('好友')}</h1>
        <MyStatus />
        <Menu>
          <MenuEntry icon={<BanIcon />} onClick={() => setTab('blocks')}>
            {t('黑名单')}
          </MenuEntry>
        </Menu>
        <IconButton label={t('关闭侧栏')} className="md:hidden" onClick={() => setSidebarOpen(false)}>
          <XIcon />
        </IconButton>
      </header>
      <div className="space-y-3 px-3 pb-3">
        <AddFriend />
        <PanelTabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'rooms', label: t('房间'), badge: roomUnread },
            { id: 'friends', label: t('好友') },
            { id: 'requests', label: t('请求'), badge: incoming },
            { id: 'notifications', label: t('通知'), badge: unread },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {friends.isError ? (
          <p role="alert" className="px-2 text-sm text-red-600">
            {errorMessage(friends.error)}
          </p>
        ) : tab === 'rooms' ? (
          <RoomList />
        ) : tab === 'blocks' ? (
          <>
            <div className="flex items-center justify-between px-2 pb-1">
              <h3 className="text-xs font-medium text-zinc-500">{t('黑名单')}</h3>
              <Button size="sm" onClick={() => setTab('friends')}>
                {t('返回')}
              </Button>
            </div>
            <Blocks />
          </>
        ) : tab === 'friends' ? (
          <FriendList friends={friends.data?.friends ?? []} />
        ) : tab === 'requests' ? (
          <Requests />
        ) : tab === 'notifications' ? (
          <Notifications />
        ) : null}
      </div>
    </div>
  )
}
