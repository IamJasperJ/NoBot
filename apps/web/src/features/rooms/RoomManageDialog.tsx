import type { RoomDTO, RoomInviteDTO, RoomMemberDTO, UpdateRoomInput } from '@nobot/shared'
import { useEffect, useState } from 'react'
import { useCharacter, useChatPages, usePersonas } from '../../api/queries'
import {
  useAcceptRoomRules,
  useBanRoomMember,
  useCreateRoomInvite,
  useDeleteRoom,
  useKickRoomMember,
  useLeaveRoom,
  useRevokeRoomInvite,
  useRoom,
  useRoomInvites,
  useRoomPersona,
  useRoomRole,
  useRoomUsage,
  useSetInitiative,
  useUpdateRoom,
} from '../../api/rooms'
import { useFriends } from '../../api/social'
import { NumberField, SelectField, SwitchField, Tabs, TextAreaField, TextField } from '../../components/form'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BanIcon,
  CopyIcon,
  LinkIcon,
  TrashIcon,
  UserIcon,
  XIcon,
} from '../../components/icons'
import { Menu, MenuDivider, MenuEntry } from '../../components/menu'
import { Avatar, Button, badgeClass, cx, Dialog, IconButton } from '../../components/ui'
import { getLanguage, t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { CharactersTab, MeExtras, SessionsTab, TransferSection } from './RoomExtras'
import {
  choiceModeHint,
  choiceModeLabel,
  modeLabel,
  type RoomTab,
  ratingClass,
  ratingLabel,
  roleLabel,
  turnModeHint,
  turnModeLabel,
  useRoomDialogs,
} from './shared'

const run = (p: Promise<unknown>, done?: string) =>
  p.then(
    () => done && toast.info(done),
    (e: unknown) => toast.error(errorMessage(e)),
  )
const time = (at: number) =>
  new Date(at).toLocaleString(getLanguage() === 'en' ? 'en-US' : 'zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

/** 房间概况：名字、等级、模式，放在弹窗顶部 */
function RoomSummary({ room }: { room: RoomDTO }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
      <span className={cx(badgeClass, ratingClass[room.contentRating])}>{ratingLabel()[room.contentRating]}</span>
      <span className={badgeClass}>{modeLabel()[room.mode]}</span>
      <span className={badgeClass}>{turnModeLabel()[room.turnMode]}</span>
      {room.status !== 'active' && (
        <span className={cx(badgeClass, 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300')}>
          {room.status === 'paused' ? t('已暂停') : t('已归档')}
        </span>
      )}
      {room.description && <p className="w-full text-zinc-500">{room.description}</p>}
    </div>
  )
}

function MemberRow({ room, member }: { room: RoomDTO; member: RoomMemberDTO }) {
  const kick = useKickRoomMember()
  const ban = useBanRoomMember()
  const role = useRoomRole()
  const me = member.userId === room.myUserId
  const manageable = member.role !== 'owner' && !me
  return (
    <li className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
      <span className="relative">
        <Avatar name={member.personaName} size={36} />
        {member.inRoom && (
          <span
            title={t('在房间里')}
            className="absolute right-0 bottom-0 size-3 rounded-full bg-green-500 ring-2 ring-white dark:ring-zinc-900"
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{member.personaName}</span>
          {me && <span className="text-xs text-zinc-400">{t('（我）')}</span>}
        </span>
        <span className="block truncate text-xs text-zinc-500">
          {member.personaDescription || t('加入于 {time}', { time: time(member.joinedAt) })}
        </span>
      </span>
      <span
        className={cx(
          badgeClass,
          member.role === 'owner' && 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
        )}
      >
        {roleLabel()[member.role]}
      </span>
      {manageable && (room.permissions.canManage || room.permissions.canKick) && (
        <Menu>
          {room.permissions.canManage && (
            <MenuEntry
              icon={<UserIcon />}
              onClick={() =>
                void run(
                  role.mutateAsync({
                    id: room.id,
                    userId: member.userId,
                    role: member.role === 'gm' ? 'player' : 'gm',
                  }),
                )
              }
            >
              {member.role === 'gm' ? t('改为玩家') : t('设为主持')}
            </MenuEntry>
          )}
          {room.permissions.canKick && (
            <>
              <MenuDivider />
              <MenuEntry
                danger
                icon={<TrashIcon />}
                onClick={() =>
                  void run(
                    kick.mutateAsync({ id: room.id, userId: member.userId }),
                    t('已请「{name}」离开房间', { name: member.personaName }),
                  )
                }
              >
                {t('踢出房间')}
              </MenuEntry>
            </>
          )}
          {room.permissions.canManage && (
            <MenuEntry
              danger
              icon={<BanIcon />}
              onClick={() =>
                void run(
                  ban.mutateAsync({ id: room.id, userId: member.userId }),
                  t('已封禁「{name}」', { name: member.personaName }),
                )
              }
            >
              {t('封禁')}
            </MenuEntry>
          )}
        </Menu>
      )}
    </li>
  )
}

function Members({ room }: { room: RoomDTO }) {
  const active = room.members.filter((m) => m.state === 'active')
  const order = { owner: 0, gm: 1, player: 2, spectator: 3 }
  return (
    <div>
      <p className="mb-2 text-xs text-zinc-500">
        {t('{count} / {max} 人', { count: active.length, max: room.maxMembers })}
      </p>
      <ul>
        {[...active]
          .sort((a, b) => order[a.role] - order[b.role] || a.joinedAt - b.joinedAt)
          .map((m) => (
            <MemberRow key={m.userId} room={room} member={m} />
          ))}
      </ul>
      {room.spectators.length > 0 && (
        <>
          <p className="mt-4 mb-2 text-xs text-zinc-500">
            {t('旁观 {count} / {max}', { count: room.spectators.length, max: room.maxSpectators })}
          </p>
          <ul>
            {room.spectators.map((m) => (
              <MemberRow key={m.userId} room={room} member={m} />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function Invite({ room }: { room: RoomDTO }) {
  const friends = useFriends()
  const invites = useRoomInvites(room.id)
  const create = useCreateRoomInvite()
  const revoke = useRevokeRoomInvite()
  const [link, setLink] = useState<string | null>(null)
  const [hours, setHours] = useState(24)
  // 开了旁观时，邀请可以选「一起玩」还是「旁观」
  const [role, setRole] = useState<'player' | 'spectator'>('player')
  const spectating = room.allowSpectators && room.myRole !== 'player'
  const inRoom = new Set([...room.members, ...room.spectators].filter((m) => m.state === 'active').map((m) => m.userId))
  const invitedTo = new Set(
    (invites.data ?? []).filter((i) => i.kind === 'direct' && !i.revokedAt).map((i) => i.targetUserId),
  )
  const candidates = (friends.data?.friends ?? []).filter((f) => !inRoom.has(f.id))
  const makeLink = () =>
    void create
      .mutateAsync({ id: room.id, input: { kind: 'link', expiresIn: hours * 3600000, role } })
      .then((invite) => {
        const url = new URL(invite.url ?? `/join/${invite.token ?? ''}`, location.origin).toString()
        setLink(url)
        void navigator.clipboard.writeText(url).then(
          () => toast.info(t('邀请链接已复制')),
          () => {},
        )
      })
      .catch((e: unknown) => toast.error(errorMessage(e)))
  // 用完、过期、撤销的都不算有效；服务端给了 status 就按它判断
  const active = (invites.data ?? []).filter((i) =>
    i.status ? i.status === 'active' : !i.revokedAt && i.expiresAt > Date.now(),
  )
  const inviteLabel = (i: RoomInviteDTO) => {
    if (i.kind === 'link')
      return t('邀请链接 · 已用 {uses}{max}', { uses: i.uses, max: i.maxUses ? ` / ${i.maxUses}` : '' })
    const friend = friends.data?.friends.find((f) => f.id === i.targetUserId)
    return t('邀请「{name}」', { name: friend?.name ?? t('好友') })
  }
  return (
    <div className="space-y-5">
      {spectating && (
        <SelectField
          label={t('邀请对方')}
          value={role}
          onChange={setRole}
          options={[
            { value: 'player', label: t('一起玩') },
            { value: 'spectator', label: t('旁观（只能看，不能发言）') },
          ]}
        />
      )}
      <section>
        <h3 className="mb-2 text-sm font-medium">{t('邀请好友')}</h3>
        {candidates.length ? (
          <ul>
            {candidates.map((f) => (
              <li key={f.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5">
                <Avatar name={f.name} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{f.name}</span>
                  <span className="block truncate text-xs text-zinc-500">@{f.handle}</span>
                </span>
                <Button
                  size="sm"
                  disabled={invitedTo.has(f.id) || create.isPending}
                  onClick={() =>
                    void run(
                      create.mutateAsync({ id: room.id, input: { kind: 'direct', targetUserId: f.id, role } }),
                      t('已邀请「{name}」', { name: f.name }),
                    )
                  }
                >
                  {invitedTo.has(f.id) ? t('已邀请') : t('邀请')}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-zinc-500">
            {friends.data?.friends.length ? t('好友都已经在房间里了') : t('还没有好友，先在「好友」里添加')}
          </p>
        )}
      </section>
      <section>
        <h3 className="mb-1 text-sm font-medium">{t('邀请链接')}</h3>
        <p className="mb-2 text-xs text-zinc-500">
          {t('只有本站已登录的用户能用；对方会先看到房间规则再决定是否加入')}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={t('有效期')}
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            className="h-8 rounded-lg border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value={1}>{t('1 小时')}</option>
            <option value={24}>{t('24 小时')}</option>
            <option value={168}>{t('7 天')}</option>
          </select>
          <Button size="sm" variant="primary" disabled={create.isPending} onClick={makeLink}>
            <LinkIcon />
            {t('生成并复制链接')}
          </Button>
        </div>
        {link && (
          <div className="mt-2 flex items-center gap-2 rounded-lg bg-zinc-100 px-3 py-2 text-xs dark:bg-zinc-800">
            <span className="min-w-0 flex-1 truncate font-mono">{link}</span>
            <Button
              size="sm"
              onClick={() =>
                void navigator.clipboard.writeText(link).then(
                  () => toast.info(t('已复制')),
                  (e: unknown) => toast.error(errorMessage(e)),
                )
              }
            >
              <CopyIcon />
            </Button>
          </div>
        )}
      </section>
      {active.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-medium">{t('有效的邀请')}</h3>
          <ul className="space-y-1">
            {active.map((i) => (
              <li key={i.id} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{inviteLabel(i)}</span>
                <span className="text-xs text-zinc-500">{t('到 {time}', { time: time(i.expiresAt) })}</span>
                <Button size="sm" onClick={() => void run(revoke.mutateAsync({ id: room.id, inviteId: i.id }))}>
                  {t('撤销')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/** 我在这个房间里：人设、确认规则、离开 */
function Me({ room, onLeft }: { room: RoomDTO; onLeft: () => void }) {
  const me = [...room.members, ...room.spectators].find((m) => m.userId === room.myUserId)
  const personas = usePersonas()
  const save = useRoomPersona()
  const accept = useAcceptRoomRules()
  const leave = useLeaveRoom()
  const [name, setName] = useState(me?.personaName ?? '')
  const [description, setDescription] = useState(me?.personaDescription ?? '')
  useEffect(() => {
    setName(me?.personaName ?? '')
    setDescription(me?.personaDescription ?? '')
  }, [me?.personaName, me?.personaDescription])
  if (!me) return null
  const mustAccept = me.acceptedRulesVersion !== room.rulesVersion
  return (
    <div className="space-y-5">
      {mustAccept && (
        <section className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
          <p className="font-medium">
            {me.role === 'spectator' ? t('房间规则有更新，请阅读并确认') : t('房间规则有更新，确认后才能继续发言')}
          </p>
          <RulesText room={room} />
          <Button
            size="sm"
            variant="primary"
            // 确认后关掉对话框回到聊天：打开它的目的就是确认规则
            onClick={() =>
              void run(
                accept
                  .mutateAsync({ id: room.id, rulesVersion: room.rulesVersion })
                  .then(() => useRoomDialogs.getState().close()),
                t('已确认'),
              )
            }
          >
            {t('我已阅读并同意')}
          </Button>
        </section>
      )}
      <section className="space-y-3">
        <h3 className="text-sm font-medium">{t('我在房间里的人设')}</h3>
        <p className="text-xs text-zinc-500">{t('只影响这个房间；已经发出的消息保留原来的名字')}</p>
        {!!personas.data?.length && (
          <SelectField
            label={t('换成我的人设')}
            value=""
            onChange={(personaId) => personaId && void run(save.mutateAsync({ id: room.id, personaId }), t('已更新'))}
            options={[{ value: '', label: t('选择…') }, ...personas.data.map((p) => ({ value: p.id, label: p.name }))]}
          />
        )}
        <TextField label={t('名字')} value={name} onChange={setName} />
        <TextAreaField label={t('描述（AI 会看到）')} value={description} onChange={setDescription} rows={3} />
        <Button
          size="sm"
          variant="primary"
          disabled={!name.trim() || (name === me.personaName && description === me.personaDescription)}
          onClick={() => void run(save.mutateAsync({ id: room.id, name: name.trim(), description }), t('已保存'))}
        >
          {t('保存')}
        </Button>
      </section>
      <MeExtras room={room} />
      {room.myRole !== 'owner' && (
        <section className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <Button
            variant="danger"
            onClick={() => {
              if (!confirm(t('确定离开「{name}」吗？之后需要重新被邀请才能回来', { name: room.name }))) return
              void leave
                .mutateAsync(room.id)
                .then(() => {
                  toast.info(t('已离开房间'))
                  onLeft()
                })
                .catch((e: unknown) => toast.error(errorMessage(e)))
            }}
          >
            {t('离开房间')}
          </Button>
        </section>
      )}
    </div>
  )
}

export function RulesText({ room }: { room: Pick<RoomDTO, 'contentRating' | 'contentNotes' | 'rules'> }) {
  return (
    <dl className="space-y-1 text-sm">
      <div className="flex gap-2">
        <dt className="shrink-0 text-zinc-500">{t('内容等级')}</dt>
        <dd>{ratingLabel()[room.contentRating]}</dd>
      </div>
      {room.contentNotes && (
        <div className="flex gap-2">
          <dt className="shrink-0 text-zinc-500">{t('内容提示')}</dt>
          <dd className="whitespace-pre-wrap">{room.contentNotes}</dd>
        </div>
      )}
      {room.rules && (
        <div className="flex gap-2">
          <dt className="shrink-0 text-zinc-500">{t('房间规则')}</dt>
          <dd className="whitespace-pre-wrap">{room.rules}</dd>
        </div>
      )}
    </dl>
  )
}

/** 房主的房间设置；内容等级、规则变化后成员需要重新确认 */
function Settings({ room, onDeleted }: { room: RoomDTO; onDeleted: () => void }) {
  const update = useUpdateRoom()
  const remove = useDeleteRoom()
  const usage = useRoomUsage(room.id)
  const [draft, setDraft] = useState<UpdateRoomInput>({})
  const value = { ...room, ...draft } as RoomDTO
  const set = (patch: UpdateRoomInput) => setDraft((d) => ({ ...d, ...patch }))
  const dirty = Object.keys(draft).length > 0
  const rulesChanged = ['contentRating', 'contentNotes', 'rules'].some(
    (k) => k in draft && draft[k as keyof UpdateRoomInput] !== room[k as keyof RoomDTO],
  )
  const today = (usage.data ?? []).filter((u) => u.createdAt > Date.now() - 86400000)
  return (
    <div className="space-y-4">
      <TextField label={t('房间名')} value={value.name} onChange={(name) => set({ name })} />
      <TextAreaField
        label={t('简介')}
        value={value.description}
        onChange={(description) => set({ description })}
        rows={2}
      />
      <SelectField
        label={t('AI 什么时候说话')}
        hint={turnModeHint()[value.turnMode]}
        value={value.turnMode}
        onChange={(turnMode) => set({ turnMode })}
        options={(['smart', 'auto', 'mention', 'host', 'initiative'] as const).map((v) => ({
          value: v,
          label: turnModeLabel()[v],
        }))}
      />
      <SelectField
        label={t('内容等级')}
        hint={t('成人及以上需要每位成员单独同意')}
        value={value.contentRating}
        onChange={(contentRating) => set({ contentRating })}
        options={(['general', 'mature', 'explicit'] as const).map((v) => ({ value: v, label: ratingLabel()[v] }))}
      />
      <TextAreaField
        label={t('内容提示')}
        placeholder={t('例如：有恐怖描写、战斗流血')}
        value={value.contentNotes}
        onChange={(contentNotes) => set({ contentNotes })}
        rows={2}
      />
      <TextAreaField
        label={t('房间规则')}
        placeholder={t('例如：OOC 用场外频道，不要替别人的角色行动')}
        value={value.rules}
        onChange={(rules) => set({ rules })}
        rows={3}
      />
      <NumberField
        label={t('人数上限')}
        value={value.maxMembers}
        onChange={(maxMembers) => set({ maxMembers })}
        min={2}
        max={32}
        slider={false}
      />
      <NumberField
        label={t('每位访客每小时最多触发')}
        value={value.guestQuota.perHour}
        onChange={(perHour) => set({ guestQuota: { ...value.guestQuota, perHour } })}
        min={0}
        max={1000}
        slider={false}
      />
      <NumberField
        label={t('房间每天最多生成')}
        hint={t('含语音和图片；房主自己不受这两项限制')}
        value={value.guestQuota.perDay}
        onChange={(perDay) => set({ guestQuota: { ...value.guestQuota, perDay } })}
        min={0}
        max={100000}
        slider={false}
      />
      <SwitchField
        label={t('玩家也能邀请好友')}
        checked={value.allowMemberInvites}
        onChange={(allowMemberInvites) => set({ allowMemberInvites })}
      />
      <SwitchField
        label={t('主持可以踢人')}
        checked={value.allowGmKick}
        onChange={(allowGmKick) => set({ allowGmKick })}
      />
      <SelectField
        label={t('剧情选项由谁来选')}
        hint={choiceModeHint()[value.choiceMode]}
        value={value.choiceMode}
        onChange={(choiceMode) => set({ choiceMode })}
        options={(['gm', 'vote', 'each'] as const).map((v) => ({ value: v, label: choiceModeLabel()[v] }))}
      />
      {value.choiceMode === 'vote' && (
        <NumberField
          label={t('投票时限（秒）')}
          value={value.voteTimeoutSeconds}
          onChange={(voteTimeoutSeconds) => set({ voteTimeoutSeconds })}
          min={10}
          max={3600}
          slider={false}
        />
      )}
      {value.turnMode === 'host' && (
        <SwitchField
          label={t('大家都点了「本轮完成」就自动让 AI 回应')}
          checked={value.autoResolveWhenReady}
          onChange={(autoResolveWhenReady) => set({ autoResolveWhenReady })}
        />
      )}
      <SwitchField
        label={t('允许旁观')}
        hint={t('旁观者只能看公开内容，不能发言、投票，也不计入回合；开启后成员需要重新确认规则')}
        checked={value.allowSpectators}
        onChange={(allowSpectators) => set({ allowSpectators })}
      />
      {value.allowSpectators && (
        <>
          <SelectField
            label={t('旁观者能看到的历史')}
            value={value.spectatorHistory}
            onChange={(spectatorHistory) => set({ spectatorHistory })}
            options={[
              { value: 'since-join', label: t('只看加入之后的') },
              { value: 'all', label: t('全部公开历史') },
            ]}
          />
          <NumberField
            label={t('旁观人数上限')}
            value={value.maxSpectators}
            onChange={(maxSpectators) => set({ maxSpectators })}
            min={0}
            max={100}
            slider={false}
          />
        </>
      )}
      <SwitchField
        label={t('主持也能审核玩家带来的角色')}
        checked={value.gmApprovesCharacters}
        onChange={(gmApprovesCharacters) => set({ gmApprovesCharacters })}
      />
      <SwitchField
        label={t('异步跑团（不在线也等）')}
        hint={t('不在线的人不会被自动跳过，大家有空时回来接着玩；可以给每轮设截止时间')}
        checked={value.asyncMode}
        onChange={(asyncMode) => set({ asyncMode })}
      />
      {value.asyncMode && (
        <NumberField
          label={t('每轮截止（小时，0 = 不限）')}
          value={value.roundDeadlineHours ?? 0}
          onChange={(h) => set({ roundDeadlineHours: h > 0 ? h : null })}
          min={0}
          max={720}
          slider={false}
        />
      )}
      {rulesChanged && <p className="text-xs text-amber-600">{t('保存后所有成员需要重新确认规则才能继续发言')}</p>}
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={!dirty || update.isPending}
          onClick={() =>
            void update
              .mutateAsync({ id: room.id, input: draft })
              .then(() => {
                setDraft({})
                toast.info(t('已保存'))
              })
              .catch((e: unknown) => toast.error(errorMessage(e)))
          }
        >
          {t('保存')}
        </Button>
        {dirty && <Button onClick={() => setDraft({})}>{t('取消')}</Button>}
      </div>
      <section className="space-y-2 border-t border-zinc-200 pt-4 text-sm dark:border-zinc-800">
        <p className="text-zinc-500">
          {t('最近 24 小时：文字 {text} 次、图片 {image} 次、语音 {tts} 次', {
            text: today.filter((u) => u.kind === 'text').length,
            image: today.filter((u) => u.kind === 'image').length,
            tts: today.filter((u) => u.kind === 'tts').length,
          })}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() =>
              void run(
                update.mutateAsync({ id: room.id, input: { status: room.status === 'paused' ? 'active' : 'paused' } }),
              )
            }
          >
            {room.status === 'paused' ? t('恢复房间') : t('暂停 AI 回应')}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (!confirm(t('关闭联机？成员会被移出，会话本身和聊天记录保留在你这里'))) return
              void remove
                .mutateAsync(room.id)
                .then(() => {
                  toast.info(t('已关闭联机'))
                  onDeleted()
                })
                .catch((e: unknown) => toast.error(errorMessage(e)))
            }}
          >
            {t('关闭联机')}
          </Button>
        </div>
      </section>
      <TransferSection room={room} />
    </div>
  )
}

/** 先攻顺序：成员和 AI 角色排成一列，上下移动调整；保存后从第一位开始 */
function InitiativeEditor({ room }: { room: RoomDTO }) {
  const page = useChatPages(room.chatId).data?.pages[0]
  const character = useCharacter(page?.chat.characterId ?? null).data
  const save = useSetInitiative()
  const people = room.members
    .filter((m) => m.state === 'active')
    .map((m) => ({ kind: 'member' as const, id: m.userId, name: m.personaName }))
  const ais = [
    ...(page?.group?.members.map((m) => ({ kind: 'character' as const, id: m.characterId, name: m.name })) ?? []),
    ...(character ? [{ kind: 'character' as const, id: character.id, name: character.name }] : []),
  ]
  const all = [...people, ...ais]
  const nameOf = (e: { kind: string; id: string }) => all.find((x) => x.kind === e.kind && x.id === e.id)?.name ?? '?'
  const [order, setOrder] = useState(room.initiative.order.length ? room.initiative.order : people)
  const missing = all.filter((x) => !order.some((e) => e.kind === x.kind && e.id === x.id))
  const move = (i: number, d: -1 | 1) =>
    setOrder((o) => {
      const next = [...o]
      const [item] = next.splice(i, 1)
      next.splice(i + d, 0, item as (typeof o)[number])
      return next
    })
  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500">
        {t('按顺序轮流行动，没轮到的人只能发场外或私信。轮到 AI 角色时它会自动发言。')}
      </p>
      <ol className="space-y-1">
        {order.map((e, i) => (
          <li
            // 顺序会被拖动，用位置加 id 做 key
            key={`${i}-${e.id}`}
            className={cx(
              'flex items-center gap-2 rounded-lg px-2 py-1.5',
              i === room.initiative.current && room.initiative.order.length
                ? 'bg-violet-50 dark:bg-violet-950/40'
                : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50',
            )}
          >
            <span className="w-5 text-right text-xs text-zinc-400 tabular-nums">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate text-sm">{nameOf(e)}</span>
            {e.kind === 'character' && <span className={badgeClass}>AI</span>}
            <IconButton label={t('上移')} disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUpIcon />
            </IconButton>
            <IconButton label={t('下移')} disabled={i === order.length - 1} onClick={() => move(i, 1)}>
              <ArrowDownIcon />
            </IconButton>
            <IconButton label={t('移出')} variant="danger" onClick={() => setOrder((o) => o.filter((_, j) => j !== i))}>
              <XIcon />
            </IconButton>
          </li>
        ))}
      </ol>
      {missing.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {missing.map((x) => (
            <Button
              key={`${x.kind}-${x.id}`}
              size="sm"
              onClick={() => setOrder((o) => [...o, { kind: x.kind, id: x.id }])}
            >
              + {x.name}
            </Button>
          ))}
        </div>
      )}
      <Button
        variant="primary"
        disabled={!order.length || save.isPending}
        onClick={() =>
          void run(
            save.mutateAsync({
              id: room.id,
              input: { order: order.map(({ kind, id }) => ({ kind, id })), current: 0 },
            }),
            t('先攻顺序已保存'),
          )
        }
      >
        {t('保存并从第一位开始')}
      </Button>
    </div>
  )
}

/** 房间管理弹窗：成员、邀请、我的人设、先攻、房间设置 */
export function RoomManageDialog() {
  const { manageRoomId, manageTab, close } = useRoomDialogs()
  const room = useRoom(manageRoomId).data
  const [tab, setTab] = useState<RoomTab>(manageTab)
  useEffect(() => setTab(manageTab), [manageTab, manageRoomId])
  if (!manageRoomId) return null
  const tabs: { id: RoomTab; label: string }[] = [
    { id: 'members', label: t('成员') },
    ...(room?.permissions.canInvite ? [{ id: 'invite' as const, label: t('邀请') }] : []),
    { id: 'me', label: t('我') },
    ...(room && (room.permissions.canProposeCharacter || room.permissions.canApproveCharacters)
      ? [{ id: 'characters' as const, label: t('角色') }]
      : []),
    { id: 'sessions', label: t('排期') },
    ...(room?.turnMode === 'initiative' && room.permissions.canManageInitiative
      ? [{ id: 'initiative' as const, label: t('先攻') }]
      : []),
    ...(room?.permissions.canManage ? [{ id: 'settings' as const, label: t('设置') }] : []),
  ]
  const leaveChat = () => {
    close()
    if (room && room.myRole !== 'owner') useUi.getState().openChat({}, null)
  }
  return (
    <Dialog open onClose={close} title={room?.name ?? t('房间')} className="w-[min(560px,calc(100vw-32px))]">
      {room ? (
        <>
          <RoomSummary room={room} />
          {/* 页签多时（先攻 + 设置）手机上横向滚动，不挤压文字 */}
          <div className="mb-4 overflow-x-auto">
            <div className="min-w-max">
              <Tabs value={tab} onChange={setTab} tabs={tabs} />
            </div>
          </div>
          {tab === 'members' && <Members room={room} />}
          {tab === 'invite' && <Invite room={room} />}
          {tab === 'me' && <Me room={room} onLeft={leaveChat} />}
          {tab === 'settings' && <Settings room={room} onDeleted={close} />}
          {tab === 'initiative' && <InitiativeEditor room={room} />}
          {tab === 'characters' && <CharactersTab room={room} />}
          {tab === 'sessions' && <SessionsTab room={room} />}
        </>
      ) : (
        <p className="text-sm text-zinc-500">{t('加载中…')}</p>
      )}
    </Dialog>
  )
}
