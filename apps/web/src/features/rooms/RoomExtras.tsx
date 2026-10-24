import type { RoomCharacterProposalDTO, RoomDTO, RoomSessionDTO } from '@nobot/shared'
import { useState } from 'react'
import { useCharacters } from '../../api/queries'
import {
  useAcceptRoomTransfer,
  useApproveRoomCharacter,
  useCancelRoomSession,
  useCreateRoomSession,
  useDeclineRoomTransfer,
  useExportRoom,
  useOfferRoomTransfer,
  useProposeRoomCharacter,
  useRejectRoomCharacter,
  useRoomCharacterProposals,
  useRoomNotifyPreference,
  useRoomSessionRsvp,
  useRoomSessions,
  useRoomTransfer,
  useWithdrawRoomCharacter,
} from '../../api/rooms'
import { SelectField, TextAreaField, TextField } from '../../components/form'
import { Avatar, Button, badgeClass, cx, inputClass } from '../../components/ui'
import { getLanguage, t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'

const run = (p: Promise<unknown>, done?: string) =>
  p.then(
    () => done && toast.info(done),
    (e: unknown) => toast.error(errorMessage(e)),
  )
const when = (at: number) =>
  new Date(at).toLocaleString(getLanguage() === 'en' ? 'en-US' : 'zh-CN', {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
const nameOf = (room: RoomDTO, userId: string) =>
  [...room.members, ...room.spectators].find((m) => m.userId === userId)?.personaName ?? '?'

const SHARE_KEYS = [
  'description',
  'personality',
  'scenario',
  'exampleDialogue',
  'sprites',
  'voice',
  'lorebook',
] as const
type ShareKey = (typeof SHARE_KEYS)[number]
const shareLabel = (): Record<ShareKey, string> => ({
  description: t('描述'),
  personality: t('性格'),
  scenario: t('场景'),
  exampleDialogue: t('对话示例'),
  sprites: t('立绘'),
  voice: t('语音设置'),
  lorebook: t('世界书'),
})

/** 提案预览：共享的文字字段、立绘缩略图、世界书条数、是否带语音 */
function PreviewSummary({ preview }: { preview: RoomCharacterProposalDTO['preview'] }) {
  const lore = preview.lorebooks.reduce((n, b) => n + b.entryCount, 0)
  return (
    <div className="space-y-1.5 text-xs text-zinc-600 dark:text-zinc-300">
      {(['description', 'personality', 'scenario'] as const).map(
        (k) =>
          preview[k] && (
            <p key={k} className="line-clamp-3">
              <span className="text-zinc-400">{shareLabel()[k]}：</span>
              {preview[k]}
            </p>
          ),
      )}
      {preview.sprites.thumbnails.length > 0 && (
        <div className="flex gap-1">
          {preview.sprites.thumbnails.map((src, i) => (
            // 缩略图顺序固定，下标做 key 安全
            <img key={i} src={src} alt="" className="h-14 w-10 rounded bg-zinc-100 object-contain dark:bg-zinc-800" />
          ))}
        </div>
      )}
      <p className="text-zinc-400">
        {[
          preview.sprites.count > 0 && t('{n} 张立绘', { n: preview.sprites.count }),
          lore > 0 && t('{n} 条世界书', { n: lore }),
          preview.voice && t('含语音设置'),
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
    </div>
  )
}

/** 带自己的角色进房：提案、房主审核、撤回 */
export function CharactersTab({ room }: { room: RoomDTO }) {
  const characters = useCharacters()
  const proposals = useRoomCharacterProposals(room.id)
  const propose = useProposeRoomCharacter()
  const approve = useApproveRoomCharacter()
  const reject = useRejectRoomCharacter()
  const withdraw = useWithdrawRoomCharacter()
  const [characterId, setCharacterId] = useState('')
  const [note, setNote] = useState('')
  const [share, setShare] = useState<Record<ShareKey, boolean>>({
    description: true,
    personality: true,
    scenario: false,
    exampleDialogue: true,
    sprites: true,
    voice: true,
    lorebook: false,
  })
  const mine = characters.data ?? []
  const list = proposals.data ?? []
  const pending = list.filter((p) => p.status === 'pending')
  const approved = list.filter((p) => p.status === 'approved' && p.copyId)
  return (
    <div className="space-y-5">
      {room.permissions.canProposeCharacter && (
        <section className="space-y-3">
          <h3 className="text-sm font-medium">{t('带我的角色进来')}</h3>
          <p className="text-xs text-zinc-500">
            {t(
              '房间里用的是一份副本：只复制你勾选的内容，你的聊天记录和记忆不会带进来，房间里发生的事也不会写回原角色。',
            )}
          </p>
          <SelectField
            label={t('角色')}
            value={characterId}
            onChange={setCharacterId}
            options={[{ value: '', label: t('选择…') }, ...mine.map((c) => ({ value: c.id, label: c.name }))]}
          />
          <fieldset className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
            <legend className="mb-1 text-xs text-zinc-500">{t('共享哪些内容（名字和头像总是共享）')}</legend>
            {SHARE_KEYS.map((k) => (
              <label key={k} className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={share[k]}
                  onChange={(e) => setShare((s) => ({ ...s, [k]: e.target.checked }))}
                  className="size-4 accent-violet-600"
                />
                {shareLabel()[k]}
              </label>
            ))}
          </fieldset>
          <TextAreaField label={t('给房主的留言')} value={note} onChange={setNote} rows={2} />
          <Button
            variant="primary"
            disabled={!characterId || propose.isPending}
            onClick={() =>
              void propose
                .mutateAsync({ id: room.id, input: { characterId, share, note } })
                .then(() => {
                  toast.info(t('已提交，等房主同意'))
                  setCharacterId('')
                  setNote('')
                })
                .catch((e: unknown) => toast.error(errorMessage(e)))
            }
          >
            {t('提交')}
          </Button>
        </section>
      )}
      {pending.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t('等待审核')}</h3>
          <ul className="space-y-2">
            {pending.map((p) => {
              const name = p.preview.name
              const avatar = p.preview.avatarUrl
              return (
                <li key={p.id} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
                  <div className="mb-2 flex items-center gap-2">
                    <Avatar name={name} url={avatar} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{name}</span>
                      <span className="block truncate text-xs text-zinc-500">
                        {t('来自 {name}', { name: nameOf(room, p.userId) })}
                      </span>
                    </span>
                  </div>
                  <PreviewSummary preview={p.preview} />
                  {p.note && <p className="mt-2 text-xs italic text-zinc-500">“{p.note}”</p>}
                  {room.permissions.canApproveCharacters && (
                    <div className="mt-3 flex gap-2">
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() =>
                          void run(
                            approve.mutateAsync({ id: room.id, proposalId: p.id }),
                            t('「{name}」加入了房间', { name }),
                          )
                        }
                      >
                        {t('同意')}
                      </Button>
                      <Button size="sm" onClick={() => void run(reject.mutateAsync({ id: room.id, proposalId: p.id }))}>
                        {t('拒绝')}
                      </Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {approved.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t('玩家带来的角色')}</h3>
          <ul>
            {approved.map((p) => {
              const name = p.preview.name
              const canWithdraw = p.userId === room.myUserId || room.permissions.canManage
              return (
                <li key={p.id} className="flex items-center gap-2 py-1.5">
                  <Avatar name={name} size={28} />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {name}
                    <span className="ml-1.5 text-xs text-zinc-500">· {nameOf(room, p.userId)}</span>
                  </span>
                  {canWithdraw && p.copyId && (
                    <Button
                      size="sm"
                      onClick={() =>
                        void run(
                          withdraw.mutateAsync({ id: room.id, copyId: p.copyId as string }),
                          t('「{name}」不再发言，历史保留', { name }),
                        )
                      }
                    >
                      {t('撤回')}
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {!room.permissions.canProposeCharacter && !list.length && (
        <p className="text-sm text-zinc-500">{t('还没有玩家带角色进来')}</p>
      )}
    </div>
  )
}

/** datetime-local 输入框用本地时间字符串 */
const toLocalInput = (ms: number) => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function SessionItem({ room, session }: { room: RoomDTO; session: RoomSessionDTO }) {
  const rsvp = useRoomSessionRsvp()
  const cancel = useCancelRoomSession()
  const options = [
    { id: 'yes', label: t('参加') },
    { id: 'maybe', label: t('可能') },
    { id: 'no', label: t('不来') },
  ] as const
  return (
    <li className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{session.title}</span>
          <span className="block text-xs text-zinc-500">
            {when(session.startsAt)} · {t('{n} 分钟', { n: session.durationMinutes })}
          </span>
          {session.note && <span className="mt-1 block text-xs text-zinc-500">{session.note}</span>}
        </span>
        {room.permissions.canSchedule && (
          <Button
            size="sm"
            variant="danger"
            onClick={() => void run(cancel.mutateAsync({ id: room.id, sessionId: session.id }), t('已取消'))}
          >
            {t('取消')}
          </Button>
        )}
      </div>
      {!room.permissions.isSpectator && (
        <div className="mt-2 flex gap-1.5">
          {options.map((o) => (
            <Button
              key={o.id}
              size="sm"
              variant={session.myRsvp === o.id ? 'primary' : 'secondary'}
              onClick={() => void run(rsvp.mutateAsync({ id: room.id, sessionId: session.id, response: o.id }))}
            >
              {o.label}
            </Button>
          ))}
        </div>
      )}
    </li>
  )
}

/** 排期：下一次开团时间、报名；房主 / 主持可以新建。开始前 30 分钟提醒报名的人 */
export function SessionsTab({ room }: { room: RoomDTO }) {
  const sessions = useRoomSessions(room.id)
  const create = useCreateRoomSession()
  const [title, setTitle] = useState('')
  const [start, setStart] = useState(() => toLocalInput(Date.now() + 86400000))
  const [minutes, setMinutes] = useState(120)
  const [note, setNote] = useState('')
  const upcoming = (sessions.data ?? [])
    .filter((s) => !s.cancelledAt && s.startsAt + s.durationMinutes * 60000 > Date.now())
    .sort((a, b) => a.startsAt - b.startsAt)
  return (
    <div className="space-y-5">
      {upcoming.length ? (
        <ul className="space-y-2">
          {upcoming.map((s) => (
            <SessionItem key={s.id} room={room} session={s} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-zinc-500">{t('还没有安排下一次开团')}</p>
      )}
      {room.permissions.canSchedule && (
        <section className="space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <h3 className="text-sm font-medium">{t('安排一次开团')}</h3>
          <TextField label={t('标题')} value={title} onChange={setTitle} placeholder={t('例如：第三章 · 地下城')} />
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span>{t('开始时间')}</span>
              <input
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className={cx(inputClass, 'h-9 py-0')}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>{t('时长（分钟）')}</span>
              <input
                type="number"
                min={15}
                max={1440}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
                className={cx(inputClass, 'h-9 w-28 py-0')}
              />
            </label>
          </div>
          <TextAreaField label={t('备注')} value={note} onChange={setNote} rows={2} />
          <Button
            variant="primary"
            disabled={!title.trim() || !start || create.isPending}
            onClick={() =>
              void create
                .mutateAsync({
                  id: room.id,
                  input: { title: title.trim(), startsAt: new Date(start).getTime(), durationMinutes: minutes, note },
                })
                .then(() => {
                  toast.info(t('已通知房间成员'))
                  setTitle('')
                  setNote('')
                })
                .catch((e: unknown) => toast.error(errorMessage(e)))
            }
          >
            {t('发布')}
          </Button>
        </section>
      )}
    </div>
  )
}

/** 「我」页签里的附加项：通知偏好、导出、收到的转让邀请 */
export function MeExtras({ room }: { room: RoomDTO }) {
  const notify = useRoomNotifyPreference()
  const exportRoom = useExportRoom()
  const transfer = useRoomTransfer(room.id)
  const accept = useAcceptRoomTransfer()
  const decline = useDeclineRoomTransfer()
  const me = [...room.members, ...room.spectators].find((m) => m.userId === room.myUserId)
  const offer = transfer.data && transfer.data.toUserId === room.myUserId ? transfer.data : null
  return (
    <div className="space-y-5">
      {offer && (
        <section className="space-y-2 rounded-lg border border-violet-300 bg-violet-50 p-3 text-sm dark:border-violet-800 dark:bg-violet-950/40">
          <p className="font-medium">{t('{name} 想把房主转给你', { name: nameOf(room, offer.fromUserId) })}</p>
          <p className="text-xs text-zinc-600 dark:text-zinc-300">
            {t('接受后故事、角色和素材会复制到你这里，之后用你自己的连接和模型生成。原房主会变成主持。')}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={accept.isPending}
              onClick={() =>
                void accept
                  .mutateAsync(room.id)
                  .then((next) => {
                    toast.info(t('你现在是房主了'))
                    useUi.getState().openChat({}, next.chatId)
                  })
                  .catch((e: unknown) => toast.error(errorMessage(e)))
              }
            >
              {accept.isPending ? t('正在复制…') : t('接受')}
            </Button>
            <Button size="sm" onClick={() => void run(decline.mutateAsync(room.id))}>
              {t('拒绝')}
            </Button>
          </div>
        </section>
      )}
      <SelectField
        label={t('这个房间的通知')}
        value={me?.notifyPreference ?? 'all'}
        onChange={(preference) => void run(notify.mutateAsync({ id: room.id, preference }), t('已更新'))}
        options={[
          { value: 'all', label: t('全部（轮到我、被提及、开团提醒）') },
          { value: 'mentions', label: t('只在被提及时') },
          { value: 'none', label: t('不通知') },
        ]}
      />
      {room.permissions.canExport && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t('导出')}</h3>
          <p className="text-xs text-zinc-500">{t('只包含你看得到的内容（当前分支）')}</p>
          <div className="flex gap-2">
            {(['markdown', 'json'] as const).map((format) => (
              <Button
                key={format}
                size="sm"
                disabled={exportRoom.isPending}
                onClick={() => void run(exportRoom.mutateAsync({ id: room.id, format }))}
              >
                {format === 'markdown' ? 'Markdown' : 'JSON'}
              </Button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

/** 房主把房间转给另一位成员 */
export function TransferSection({ room }: { room: RoomDTO }) {
  const transfer = useRoomTransfer(room.id)
  const offer = useOfferRoomTransfer()
  const [target, setTarget] = useState('')
  const candidates = room.members.filter((m) => m.state === 'active' && m.role !== 'owner')
  if (!room.permissions.canTransfer) return null
  const pending = transfer.data
  return (
    <section className="space-y-2 border-t border-zinc-200 pt-4 text-sm dark:border-zinc-800">
      <h3 className="font-medium">{t('转让房主')}</h3>
      <p className="text-xs text-zinc-500">
        {t(
          '对方接受后，故事和用到的角色、素材会复制给对方，由对方的模型继续生成；你的原会话保留为普通会话。连接和密钥不会复制。',
        )}
      </p>
      {pending ? (
        <p className="text-xs">
          <span className={badgeClass}>{t('等待 {name} 回应', { name: nameOf(room, pending.toUserId) })}</span>
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-40 flex-1">
            <SelectField
              label={t('转给')}
              value={target}
              onChange={setTarget}
              options={[
                { value: '', label: t('选择…') },
                ...candidates.map((m) => ({ value: m.userId, label: m.personaName })),
              ]}
            />
          </div>
          <Button
            disabled={!target || offer.isPending}
            onClick={() => {
              if (!confirm(t('确定把房间转给「{name}」吗？', { name: nameOf(room, target) }))) return
              void run(offer.mutateAsync({ id: room.id, userId: target }), t('已发出转让邀请'))
            }}
          >
            {t('发出邀请')}
          </Button>
        </div>
      )}
    </section>
  )
}
