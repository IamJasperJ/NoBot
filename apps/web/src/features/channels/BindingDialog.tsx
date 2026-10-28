import { useEffect, useState } from 'react'
import {
  type ChannelAccountDTO,
  type ChannelBindingDTO,
  type ChannelBindingInput,
  useChannelAccounts,
  useChannelActors,
  useChannelBinding,
  useChannelSettings,
  useDisableChannelBinding,
  useLeaveChannelBinding,
  useUpdateChannelActor,
  useUpdateChannelBinding,
} from '../../api/channels'
import { useCharacters, usePersonas } from '../../api/queries'
import { useRooms } from '../../api/rooms'
import { SelectField, Tabs } from '../../components/form'
import { PlusIcon, TrashIcon } from '../../components/icons'
import { Avatar, Button, badgeClass, cx, Dialog, IconButton, selectClass } from '../../components/ui'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { useRoomDialogs } from '../rooms/shared'
import {
  isolationLabel,
  OverrideEditor,
  personaModeOptions,
  scopeLabel,
  stateMeta,
  timeAgo,
  triggerOptions,
} from './shared'

type Tab = 'session' | 'members' | 'behavior' | 'speakers'
type Patch = Partial<ChannelBindingInput>

/** 一个群 / 私聊 / 话题的设置：接哪个会话、怎么隔离、谁说话、行为覆盖 */
export function BindingDialog({
  bindingId,
  account,
  onClose,
}: {
  bindingId: string | null
  account: ChannelAccountDTO
  onClose: () => void
}) {
  const binding = useChannelBinding(bindingId ?? '').data
  const [tab, setTab] = useState<Tab>('session')
  const [draft, setDraft] = useState<Patch>({})
  const update = useUpdateChannelBinding()
  useEffect(() => {
    setDraft({})
    setTab('session')
  }, [bindingId])
  if (!bindingId || !binding) return null
  const merged = { ...binding, ...draft } as ChannelBindingDTO
  const dirty = Object.keys(draft).length > 0
  const patch = (p: Patch) => setDraft((d) => ({ ...d, ...p }))
  const save = () =>
    update.mutate(
      { id: binding.id, patch: draft },
      {
        onSuccess: () => {
          setDraft({})
          toast.info(t('已保存'))
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    )
  return (
    <Dialog open onClose={onClose} title={binding.title || binding.chat} className="w-[min(900px,calc(100vw-32px))]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className={cx(badgeClass, 'font-normal')}>{scopeLabel(binding)}</span>
          <span className={stateMeta(binding.state).cls}>{stateMeta(binding.state).label}</span>
          <span className="font-mono text-zinc-400">{binding.chat}</span>
        </div>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'session', label: t('会话') },
            { id: 'members', label: t('成员') },
            { id: 'behavior', label: t('行为') },
            ...(binding.scope === 'group' ? [{ id: 'speakers' as const, label: t('多 bot 发言') }] : []),
          ]}
        />
        {tab === 'session' && <SessionTab binding={merged} patch={patch} onClose={onClose} />}
        {tab === 'members' && <MembersTab binding={binding} account={account} />}
        {tab === 'behavior' && (
          <BehaviorTab
            provider={account.provider}
            binding={binding}
            value={merged.settings ?? {}}
            onChange={(settings) => patch({ settings })}
          />
        )}
        {tab === 'speakers' && (
          <SpeakersTab account={account} value={merged.speakers ?? {}} onChange={(speakers) => patch({ speakers })} />
        )}
        {tab !== 'members' && (
          <div className="sticky -bottom-5 z-10 -mx-5 -mb-5 flex items-center justify-end gap-2 border-t border-zinc-200 bg-white px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900">
            {dirty && <span className="mr-auto text-xs text-amber-600">{t('有未保存的修改')}</span>}
            <Button disabled={!dirty} onClick={() => setDraft({})}>
              {t('撤销')}
            </Button>
            <Button variant="primary" disabled={!dirty || update.isPending} onClick={save}>
              {t('保存')}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  )
}

function SessionTab({
  binding,
  patch,
  onClose,
}: {
  binding: ChannelBindingDTO
  patch: (p: Patch) => void
  onClose: () => void
}) {
  const rooms = (useRooms().data ?? []).filter((r) => r.myRole === 'owner')
  const disable = useDisableChannelBinding()
  const leave = useLeaveChannelBinding()
  const [confirmLeave, setConfirmLeave] = useState(false)
  const openChat = () => {
    useUi.getState().openView('chat')
    useUi.getState().openChat({}, binding.chatId)
    onClose()
  }
  const group = binding.scope === 'group'
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="space-y-4">
        <div className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <span className="min-w-0 flex-1 truncate text-[13px]">
            <span className="text-zinc-500">{t('NoBot 会话：')}</span>
            {binding.chatTitle || t('未命名会话')}
          </span>
          <Button size="sm" onClick={openChat}>
            {t('打开')}
          </Button>
          {binding.roomId && (
            <Button
              size="sm"
              onClick={() => useRoomDialogs.getState().openManage(binding.roomId as string, 'settings')}
            >
              {t('房间设置')}
            </Button>
          )}
        </div>
        <SelectField
          label={t('会话来源')}
          value={binding.source}
          onChange={(source) => patch({ source })}
          options={[
            { value: 'new', label: t('单独的会话（新建）') },
            { value: 'attached', label: t('接到我已有的房间') },
            { value: 'account-shared', label: t('和这个 bot 的所有地方共用一个会话') },
          ]}
        />
        {binding.source === 'attached' && (
          <SelectField
            label={t('房间')}
            hint={t('网页上的成员和这里的人会在同一个房间里一起玩')}
            value={binding.roomId ?? ''}
            onChange={(id) => {
              const room = rooms.find((r) => r.id === id)
              if (room) patch({ roomId: room.id, chatId: room.chatId })
            }}
            options={[{ value: '', label: t('选择房间') }, ...rooms.map((r) => ({ value: r.id, label: r.name }))]}
          />
        )}
        {binding.source === 'account-shared' && (
          <p className="text-xs leading-relaxed text-amber-600">
            {t('所有私聊和群都进同一个会话，角色记得你在哪说过什么。只有你自己能用，别人发消息会被拒绝。')}
          </p>
        )}
      </section>
      <section className="space-y-4">
        {group && (
          <SelectField
            label={t('群里的人怎么分会话')}
            value={binding.isolation}
            onChange={(isolation) => patch({ isolation })}
            options={(['shared', 'per-user', 'per-topic'] as const).map((v) => ({
              value: v,
              label: isolationLabel(v),
            }))}
          />
        )}
        <SelectField
          label={t('什么时候回复')}
          value={binding.trigger}
          onChange={(trigger) => patch({ trigger })}
          options={[...triggerOptions()]}
        />
        <SelectField
          label={t('玩家人设')}
          value={binding.personaMode ?? ''}
          onChange={(v) => patch({ personaMode: (v || null) as ChannelBindingDTO['personaMode'] })}
          options={[{ value: '', label: t('跟随机器人设置') }, ...personaModeOptions()]}
        />
      </section>
      <section className="flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3 lg:col-span-2 dark:border-zinc-800">
        {binding.state === 'active' && (
          <Button
            disabled={disable.isPending}
            onClick={() =>
              disable.mutate(binding.id, {
                onSuccess: () => toast.info(t('已停用，bot 在这里不再说话')),
                onError: (e) => toast.error(errorMessage(e)),
              })
            }
          >
            {t('停用')}
          </Button>
        )}
        {group &&
          binding.state !== 'left' &&
          (confirmLeave ? (
            <>
              <span className="text-[13px] text-red-600">{t('退出后要重新拉 bot 进群才能恢复。')}</span>
              <Button
                variant="danger"
                disabled={leave.isPending}
                onClick={() =>
                  leave.mutate(
                    { id: binding.id, confirm: true },
                    {
                      onSuccess: () => toast.info(t('已退出群')),
                      onError: (e) => toast.error(errorMessage(e)),
                    },
                  )
                }
              >
                {t('确认退群')}
              </Button>
              <Button onClick={() => setConfirmLeave(false)}>{t('取消')}</Button>
            </>
          ) : (
            <Button variant="danger" onClick={() => setConfirmLeave(true)}>
              {t('退出这个群')}
            </Button>
          ))}
      </section>
    </div>
  )
}

function MembersTab({ binding, account }: { binding: ChannelBindingDTO; account: ChannelAccountDTO }) {
  const actors = (useChannelActors().data ?? []).filter((a) => a.accountIds?.includes(account.id))
  const personas = usePersonas().data ?? []
  const update = useUpdateChannelActor()
  const assign = (binding.personaMode ?? account.personaMode) === 'owner-assigned'
  if (actors.length === 0)
    return <p className="py-6 text-center text-sm text-zinc-500">{t('还没有人在这里说过话。')}</p>
  const change = (id: string, p: Parameters<typeof update.mutate>[0]['patch']) =>
    update.mutate({ id, patch: p }, { onError: (e) => toast.error(errorMessage(e)) })
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-zinc-500">
        {t('列出见过这个 bot 的人。群里可以回复某人的消息发 /invite 授权、/kick 移出。')}
      </p>
      <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {actors.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <Avatar name={a.displayName} size={28} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px]">{a.displayName}</span>
              <span className="block truncate text-xs text-zinc-500">
                {[
                  a.username && `@${a.username}`,
                  a.linkedUserId ? t('已配对 NoBot 账号') : t('外部成员'),
                  a.personaName,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
            {assign && (
              <select
                aria-label={t('人设')}
                className={cx(selectClass, 'w-36')}
                value={a.personaId ?? ''}
                onChange={(e) => change(a.id, { personaId: e.target.value || null })}
              >
                <option value="">{t('平台昵称')}</option>
                {personas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            <select
              aria-label={t('身份')}
              className={cx(selectClass, 'w-28')}
              value={a.role}
              disabled={a.role === 'owner'}
              onChange={(e) => change(a.id, { role: e.target.value as 'player' | 'blocked' })}
            >
              {a.role === 'owner' && <option value="owner">{t('我')}</option>}
              <option value="player">{t('玩家')}</option>
              <option value="blocked">{t('已屏蔽')}</option>
            </select>
          </li>
        ))}
      </ul>
      {binding.roomId && (
        <Button size="sm" onClick={() => useRoomDialogs.getState().openManage(binding.roomId as string, 'members')}>
          {t('在房间里管理成员')}
        </Button>
      )}
    </div>
  )
}

function BehaviorTab({
  provider,
  binding,
  value,
  onChange,
}: {
  provider: ChannelAccountDTO['provider']
  binding: ChannelBindingDTO
  value: ChannelBindingDTO['settings']
  onChange: (v: ChannelBindingDTO['settings']) => void
}) {
  const resolved = useChannelSettings(binding.id).data
  if (!resolved) return null
  return (
    <div className="space-y-3">
      {binding.voicePreference && <VoicePreferenceNote binding={binding} />}
      <OverrideEditor
        provider={provider}
        value={value}
        effective={resolved.values}
        // 本层没覆盖时，来源一定在上层；服务端的 provenance 可能还是保存前的「binding」，退回到机器人
        inheritedFrom={(key) => (resolved.provenance[key] === 'binding' ? 'account' : resolved.provenance[key])}
        onChange={onChange}
      />
    </div>
  )
}

/** 聊天里说过「多发语音 / 别发语音」后记下的偏好；只在「让角色自己决定」时生效，可以一键清掉 */
function VoicePreferenceNote({ binding }: { binding: ChannelBindingDTO }) {
  const update = useUpdateChannelBinding()
  const pref = binding.voicePreference
  if (!pref) return null
  const what = pref.suppressed
    ? t('不要发语音')
    : pref.bias === 'high'
      ? t('多发语音')
      : pref.bias === 'low'
        ? t('少发语音')
        : t('正常发语音')
  return (
    <div className="flex items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-[13px] text-violet-800 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-200">
      <span className="min-w-0 flex-1">
        {t('这里有人说过「{what}」（{time}），角色自己决定发语音时会照做。', {
          what,
          time: timeAgo(pref.updatedAt),
        })}
      </span>
      <Button
        size="sm"
        disabled={update.isPending}
        onClick={() =>
          update.mutate(
            { id: binding.id, patch: { voicePreference: null } },
            { onSuccess: () => toast.info(t('已清除')), onError: (e) => toast.error(errorMessage(e)) },
          )
        }
      >
        {t('清除')}
      </Button>
    </div>
  )
}

function SpeakersTab({
  account,
  value,
  onChange,
}: {
  account: ChannelAccountDTO
  value: Record<string, string>
  onChange: (v: Record<string, string>) => void
}) {
  const characters = useCharacters().data ?? []
  const accounts = (useChannelAccounts().data ?? []).filter((a) => a.provider === account.provider)
  const [adding, setAdding] = useState('')
  const used = Object.keys(value)
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-zinc-500">
        {t(
          '群聊里有多个角色时，可以让某个角色用它自己的 bot 发言（那个 bot 也要在这个群里）。没设置的角色由当前 bot 带名字代发。',
        )}
      </p>
      <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {used.length === 0 && <li className="px-3 py-3 text-[13px] text-zinc-500">{t('全部由当前 bot 发言')}</li>}
        {used.map((characterId) => {
          const c = characters.find((x) => x.id === characterId)
          return (
            <li key={characterId} className="flex items-center gap-2 px-3 py-2">
              <Avatar name={c?.name ?? '?'} url={c?.avatarUrl ?? null} size={28} />
              <span className="min-w-0 flex-1 truncate text-[13px]">{c?.name ?? characterId}</span>
              <select
                aria-label={t('发言的 bot')}
                className={cx(selectClass, 'w-44')}
                value={value[characterId]}
                onChange={(e) => onChange({ ...value, [characterId]: e.target.value })}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.botUsername ? `@${a.botUsername}` : a.name}
                  </option>
                ))}
              </select>
              <IconButton
                label={t('移除')}
                onClick={() => {
                  const next = { ...value }
                  delete next[characterId]
                  onChange(next)
                }}
              >
                <TrashIcon />
              </IconButton>
            </li>
          )
        })}
      </ul>
      <div className="flex gap-2">
        <select
          aria-label={t('角色')}
          className={cx(selectClass, 'w-56')}
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
        >
          <option value="">{t('选择角色')}</option>
          {characters
            .filter((c) => !used.includes(c.id))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
        <Button
          disabled={!adding}
          onClick={() => {
            onChange({ ...value, [adding]: account.id })
            setAdding('')
          }}
        >
          <PlusIcon />
          {t('添加')}
        </Button>
      </div>
    </div>
  )
}
