import type { CreateRoomInput, RoomDTO } from '@nobot/shared'
import { useEffect, useState } from 'react'
import { useChatPages, usePersonas } from '../../api/queries'
import { joinInviteFromPath, useCreateRoom, useJoinRoom, useRoomLobby } from '../../api/rooms'
import { NumberField, SelectField, TextAreaField, TextField } from '../../components/form'
import { Avatar, Button, badgeClass, cx, Dialog } from '../../components/ui'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { RoomManageDialog, RulesText } from './RoomManageDialog'
import { modeLabel, ratingClass, ratingLabel, turnModeHint, turnModeLabel, useRoomDialogs } from './shared'

/** 每种玩法的默认回合方式：陪聊智能接话，跑团主持收束 */
const defaultTurn: Record<RoomDTO['mode'], RoomDTO['turnMode']> = { chat: 'smart', trpg: 'host', custom: 'auto' }

/** 把当前会话开成联机房间 */
function CreateRoomDialog({ chatId }: { chatId: string }) {
  const close = useRoomDialogs((s) => s.close)
  const openManage = useRoomDialogs((s) => s.openManage)
  const chat = useChatPages(chatId).data?.pages[0]?.chat
  const create = useCreateRoom()
  const [form, setForm] = useState<
    Required<Pick<CreateRoomInput, 'name' | 'description' | 'mode' | 'turnMode'>> &
      Pick<RoomDTO, 'contentRating' | 'contentNotes' | 'rules' | 'maxMembers'>
  >({
    name: chat?.title ?? '',
    description: '',
    mode: 'chat',
    turnMode: 'smart',
    contentRating: 'general',
    contentNotes: '',
    rules: '',
    maxMembers: 8,
  })
  useEffect(() => {
    if (chat?.title) setForm((f) => (f.name ? f : { ...f, name: chat.title }))
  }, [chat?.title])
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))
  const submit = () =>
    void create
      .mutateAsync({ ...form, name: form.name.trim(), chatId })
      .then((room) => {
        toast.info(t('联机已开启，邀请好友加入吧'))
        close()
        openManage(room.id, 'invite')
      })
      .catch((e: unknown) => toast.error(errorMessage(e)))
  return (
    <Dialog open onClose={close} title={t('开启联机')} className="w-[min(560px,calc(100vw-32px))]">
      <div className="space-y-4">
        <p className="text-sm text-zinc-500">
          {t('好友可以加入这个会话，和你一起与角色聊天。生成用你的连接和模型，好友看不到你的密钥和设置。')}
        </p>
        <TextField label={t('房间名')} value={form.name} onChange={(name) => set({ name })} />
        <TextAreaField
          label={t('简介')}
          placeholder={t('告诉好友这是个什么样的故事')}
          value={form.description}
          onChange={(description) => set({ description })}
          rows={2}
        />
        <SelectField
          label={t('玩法')}
          value={form.mode}
          onChange={(mode) => set({ mode, turnMode: defaultTurn[mode] })}
          options={(['chat', 'trpg', 'custom'] as const).map((v) => ({ value: v, label: modeLabel()[v] }))}
        />
        <SelectField
          label={t('AI 什么时候说话')}
          hint={turnModeHint()[form.turnMode]}
          value={form.turnMode}
          onChange={(turnMode) => set({ turnMode })}
          options={(['smart', 'auto', 'mention', 'host', 'initiative'] as const).map((v) => ({
            value: v,
            label: turnModeLabel()[v],
          }))}
        />
        <SelectField
          label={t('内容等级')}
          hint={t('成人及以上需要每位成员单独同意')}
          value={form.contentRating}
          onChange={(contentRating) => set({ contentRating })}
          options={(['general', 'mature', 'explicit'] as const).map((v) => ({ value: v, label: ratingLabel()[v] }))}
        />
        <TextAreaField
          label={t('内容提示')}
          placeholder={t('例如：有恐怖描写、战斗流血')}
          value={form.contentNotes}
          onChange={(contentNotes) => set({ contentNotes })}
          rows={2}
        />
        <NumberField
          label={t('人数上限')}
          value={form.maxMembers}
          onChange={(maxMembers) => set({ maxMembers })}
          min={2}
          max={32}
          slider={false}
        />
        <div className="flex justify-end gap-2">
          <Button onClick={close}>{t('取消')}</Button>
          <Button variant="primary" disabled={!form.name.trim() || create.isPending} onClick={submit}>
            {t('开启联机')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/** 入房大厅：先看清楚房间是什么、谁出模型、有什么规则，再选人设、同意加入 */
function LobbyDialog({ invite }: { invite: string }) {
  const close = useRoomDialogs((s) => s.close)
  const lobby = useRoomLobby(invite)
  const personas = usePersonas()
  const join = useJoinRoom()
  const [personaId, setPersonaId] = useState('')
  const [agreed, setAgreed] = useState(false)
  useEffect(() => {
    if (!personaId && personas.data?.length)
      setPersonaId((personas.data.find((p) => p.isDefault) ?? personas.data[0])?.id ?? '')
  }, [personas.data, personaId])
  const room = lobby.data
  const leave = () => {
    close()
    // 从链接进来的：去掉地址栏里的 /join/…，刷新后不会再弹出
    if (joinInviteFromPath()) history.replaceState(null, '', '/')
  }
  // 已经是成员（邀请可能已经用完）：不再走加入流程，直接进房间
  const already = room?.alreadyInRoom ? room.room : undefined
  // leave 每次渲染都是新函数，只在拿到房间时跑一次
  // biome-ignore lint/correctness/useExhaustiveDependencies: 见上
  useEffect(() => {
    if (!already) return
    toast.info(t('你已经在「{name}」里了', { name: already.name }))
    leave()
    useUi.getState().openChat({}, already.chatId)
  }, [already])
  const submit = () => {
    if (!room) return
    void join
      .mutateAsync({ invite, personaId, acceptedRulesVersion: room.rulesVersion })
      .then((joined) => {
        toast.info(t('已加入「{name}」', { name: joined.name }))
        leave()
        useUi.getState().openChat({}, joined.chatId)
      })
      .catch((e: unknown) => toast.error(errorMessage(e)))
  }
  return (
    <Dialog open onClose={leave} title={room?.name ?? t('房间邀请')} className="w-[min(560px,calc(100vw-32px))]">
      {lobby.isPending ? (
        <p className="text-sm text-zinc-500">{t('加载中…')}</p>
      ) : !room ? (
        <div className="space-y-3 text-sm">
          <p>{t('邀请无效或已过期，请让好友重新发一次。')}</p>
          <Button onClick={leave}>{t('关闭')}</Button>
        </div>
      ) : (
        <div className="space-y-5 text-sm">
          <section className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cx(badgeClass, ratingClass[room.contentRating])}>
                {ratingLabel()[room.contentRating]}
              </span>
              <span className="text-zinc-500">{t('房主：{name}', { name: room.hostName })}</span>
            </div>
            {room.description && <p className="whitespace-pre-wrap">{room.description}</p>}
          </section>
          {room.characters.length > 0 && (
            <section>
              <h3 className="mb-2 font-medium">{t('角色')}</h3>
              <ul className="space-y-2">
                {room.characters.map((c) => (
                  <li key={c.name} className="flex items-start gap-3">
                    <Avatar name={c.name} url={c.avatarUrl} size={36} />
                    <span className="min-w-0">
                      <span className="block font-medium">{c.name}</span>
                      {c.description && <span className="line-clamp-2 text-zinc-500">{c.description}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h3 className="mb-1 font-medium">{t('成员')}</h3>
            <p className="text-zinc-500">{room.members.join('、') || t('还没有人')}</p>
          </section>
          <section className="space-y-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50">
            <RulesText room={room} />
            <p className="text-zinc-500">{room.payer}</p>
            <p className="text-zinc-500">{room.historyNote}</p>
            {/* 旁观者不能触发 AI，不显示额度 */}
            {room.inviteRole !== 'spectator' && (
              <p className="text-zinc-500">{t('你每小时最多触发 AI {count} 次', { count: room.guestQuota.perHour })}</p>
            )}
          </section>
          <section className="space-y-3">
            {personas.data?.length ? (
              <SelectField
                label={t('用哪个人设加入')}
                hint={t('名字和描述会复制到房间里，AI 会看到；之后可以单独修改')}
                value={personaId}
                onChange={setPersonaId}
                options={personas.data.map((p) => ({ value: p.id, label: p.name }))}
              />
            ) : (
              <p className="text-amber-600">{t('你还没有人设，先在「人设」里创建一个')}</p>
            )}
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-0.5 size-4 accent-violet-600"
              />
              <span>
                {room.contentRating === 'general'
                  ? t('我已阅读并同意房间规则')
                  : t('我已成年，接受上面的内容等级和提示，并同意房间规则')}
              </span>
            </label>
          </section>
          <div className="flex justify-end gap-2">
            <Button onClick={leave}>{t('暂不加入')}</Button>
            <Button variant="primary" disabled={!agreed || !personaId || join.isPending} onClick={submit}>
              {t('加入房间')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}

/** 挂在 App 根部：房间相关的三个弹窗，以及打开 /join/<令牌> 链接时自动进大厅 */
export function RoomDialogs() {
  const { createForChatId, lobbyInvite, manageRoomId, openLobby } = useRoomDialogs()
  useEffect(() => {
    const invite = joinInviteFromPath()
    if (invite) openLobby(invite)
  }, [openLobby])
  return (
    <>
      {createForChatId && <CreateRoomDialog key={createForChatId} chatId={createForChatId} />}
      {lobbyInvite && <LobbyDialog key={lobbyInvite} invite={lobbyInvite} />}
      {manageRoomId && <RoomManageDialog />}
    </>
  )
}
