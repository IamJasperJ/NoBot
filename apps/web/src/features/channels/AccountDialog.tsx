import { channelSettingsSchema } from '@nobot/shared'
import { useEffect, useState } from 'react'
import {
  type ChannelAccountDTO,
  type ChannelAccountInput,
  type ChannelPolicies,
  type ChannelPresence,
  type ChannelSettingsOverride,
  useApplyChannelPresence,
  useChannelAccounts,
  useChannelBindings,
  useChannelPresencePreview,
  useManagedBotAccess,
  useManagedBotLink,
  useRotateManagedBotToken,
  useSyncChannelPresence,
  useUpdateChannelAccount,
  useUpdateChannelPolicies,
  useUpdateManagedBotAccess,
} from '../../api/channels'
import { useCharacters, useExtensions, usePersonas } from '../../api/queries'
import { NumberField, SelectField, SwitchField, Tabs, TextAreaField, TextField } from '../../components/form'
import { Avatar, Button, badgeClass, controlClass, cx, Dialog, selectClass } from '../../components/ui'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'
import { BindingDialog } from './BindingDialog'
import {
  capabilityLabel,
  isolationLabel,
  OverrideEditor,
  personaModeOptions,
  providerLabel,
  scopeLabel,
  stateMeta,
  statusMeta,
  timeAgo,
} from './shared'

type Tab = 'basic' | 'presence' | 'policies' | 'persona' | 'behavior' | 'places'
type Draft = Partial<Omit<ChannelAccountInput, 'credentials'>> & { token?: string }

/** 一个机器人的全部设置；按页签分开，草稿统一由底部「保存」提交（政策单独保存，因为可能需要确认） */
export function AccountDialog({ account, onClose }: { account: ChannelAccountDTO | null; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('basic')
  const [draft, setDraft] = useState<Draft>({})
  const [bindingId, setBindingId] = useState<string | null>(null)
  const update = useUpdateChannelAccount()
  useEffect(() => {
    setDraft({})
    setTab('basic')
  }, [account?.id])
  if (!account) return null
  const merged = { ...account, ...draft } as ChannelAccountDTO & Draft
  const dirty = Object.keys(draft).length > 0
  const patch = (p: Draft) => setDraft((d) => ({ ...d, ...p }))
  const save = () => {
    const { token, ...rest } = draft
    update.mutate(
      { id: account.id, patch: { ...rest, ...(token ? { credentials: { token } } : {}) } },
      {
        onSuccess: () => {
          setDraft({})
          toast.info(t('已保存'))
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    )
  }
  return (
    <Dialog open onClose={onClose} title={account.name} className="w-[min(980px,calc(100vw-32px))]">
      <div className="space-y-4">
        <div className="-mx-1 overflow-x-auto px-1">
          <div className="min-w-[560px]">
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'basic', label: t('基本') },
                { id: 'presence', label: t('资料') },
                { id: 'policies', label: t('进群与好友') },
                { id: 'persona', label: t('玩家人设') },
                { id: 'behavior', label: t('行为') },
                { id: 'places', label: t('群和私聊') },
              ]}
            />
          </div>
        </div>
        {tab === 'basic' && <BasicTab account={account} draft={merged} token={draft.token} patch={patch} />}
        {tab === 'presence' && (
          <PresenceTab account={account} presence={merged.presence as ChannelPresence} patch={patch} />
        )}
        {tab === 'policies' && <PoliciesTab account={account} />}
        {tab === 'persona' && <PersonaTab draft={merged} patch={patch} />}
        {tab === 'behavior' && (
          <BehaviorTab
            value={(merged.settings ?? {}) as ChannelSettingsOverride}
            onChange={(settings) => patch({ settings })}
          />
        )}
        {tab === 'places' && <PlacesTab account={account} onOpen={setBindingId} />}
        {tab !== 'policies' && tab !== 'places' && (
          <div className="sticky bottom-0 -mx-5 -mb-5 flex items-center justify-end gap-2 border-t border-zinc-200 bg-white px-5 py-3 dark:border-zinc-800 dark:bg-zinc-900">
            {dirty && <span className="mr-auto text-xs text-amber-600">{t('有未保存的修改')}</span>}
            <Button variant="secondary" disabled={!dirty} onClick={() => setDraft({})}>
              {t('撤销')}
            </Button>
            <Button variant="primary" disabled={!dirty || update.isPending} onClick={save}>
              {t('保存')}
            </Button>
          </div>
        )}
      </div>
      <BindingDialog bindingId={bindingId} account={account} onClose={() => setBindingId(null)} />
    </Dialog>
  )
}

function CharacterSelect({
  label,
  hint,
  value,
  onChange,
  emptyLabel,
}: {
  label: string
  hint?: string
  value: string | null | undefined
  onChange: (id: string | null) => void
  emptyLabel: string
}) {
  const characters = useCharacters().data ?? []
  return (
    <SelectField
      label={label}
      hint={hint}
      value={value ?? ''}
      onChange={(v) => onChange(v || null)}
      options={[{ value: '', label: emptyLabel }, ...characters.map((c) => ({ value: c.id, label: c.name }))]}
    />
  )
}

function BasicTab({
  account,
  draft,
  token,
  patch,
}: {
  account: ChannelAccountDTO
  draft: ChannelAccountDTO & Draft
  token: string | undefined
  patch: (p: Draft) => void
}) {
  const status = statusMeta(account.status)
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="space-y-4">
        <div className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-[13px] dark:border-zinc-800">
          <span className={cx('size-2 rounded-full', status.dot)} />
          <span>{status.label}</span>
          <span className="text-zinc-400">·</span>
          <span className="text-zinc-500">{providerLabel(account.provider)}</span>
          {account.botUsername && <span className="ml-auto font-mono text-zinc-500">@{account.botUsername}</span>}
        </div>
        {account.lastError && <p className="text-xs text-red-600">{account.lastError}</p>}
        <TextField label={t('名称')} value={draft.name ?? ''} onChange={(name) => patch({ name })} />
        <TextField
          label={t('Bot Token')}
          type="password"
          hint={t('留空表示不修改')}
          placeholder={account.credentials}
          value={token ?? ''}
          onChange={(v) => patch({ token: v })}
        />
        <SelectField
          label={t('接收消息的方式')}
          hint={t('长轮询不需要公网地址，适合家里的电脑；Webhook 需要一个 Telegram 能访问的 HTTPS 地址')}
          value={draft.receiveMode ?? 'polling'}
          onChange={(receiveMode) => patch({ receiveMode })}
          options={[
            { value: 'polling', label: t('长轮询') },
            { value: 'webhook', label: 'Webhook' },
          ]}
        />
        {draft.receiveMode === 'webhook' && (
          <TextField
            label={t('公网地址')}
            placeholder="https://nobot.example.com"
            value={draft.webhookUrl ?? ''}
            onChange={(v) => patch({ webhookUrl: v || null })}
          />
        )}
        <details className="text-[13px]">
          <summary className="cursor-pointer text-zinc-500">{t('高级')}</summary>
          <div className="pt-3">
            <TextField
              label={t('Bot API 地址')}
              hint={t('用自建的 Bot API 服务时修改')}
              value={draft.baseUrl ?? ''}
              onChange={(baseUrl) => patch({ baseUrl })}
            />
          </div>
        </details>
      </section>
      <section className="space-y-4">
        <SelectField
          label={t('扮演方式')}
          value={draft.characterMode ?? 'generic'}
          onChange={(characterMode) => patch({ characterMode })}
          options={[
            { value: 'fixed', label: t('一角色一 bot：这个 bot 就是某个角色') },
            { value: 'generic', label: t('通用 bot：每个群 / 私聊各自选角色（/char）') },
          ]}
        />
        {draft.characterMode === 'fixed' ? (
          <CharacterSelect
            label={t('角色')}
            value={draft.characterId}
            onChange={(characterId) => patch({ characterId })}
            emptyLabel={t('未选择')}
          />
        ) : (
          <CharacterSelect
            label={t('新位置的默认角色')}
            hint={t('不选时，第一次说话会先让对方用按钮选角色')}
            value={draft.defaultCharacterId}
            onChange={(defaultCharacterId) => patch({ defaultCharacterId })}
            emptyLabel={t('先让对方选')}
          />
        )}
        <MiniAppStatus account={account} />
        {account.canManageBots && <CreateManagedBot account={account} />}
        {account.managedBy && <ManagedBotPanel account={account} />}
      </section>
    </div>
  )
}

function MiniAppStatus({ account }: { account: ChannelAccountDTO }) {
  const { miniApp } = account
  return (
    <div className="space-y-1 rounded-lg border border-zinc-200 px-3 py-2 text-[13px] dark:border-zinc-800">
      <div className="flex items-center gap-2">
        <span className={cx('size-2 rounded-full', miniApp.available ? 'bg-emerald-500' : 'bg-zinc-400')} />
        <span className="font-medium">{t('VN 舞台（Mini App）')}</span>
        <span className="text-zinc-500">{miniApp.available ? t('可用') : t('不可用')}</span>
      </div>
      {miniApp.available ? (
        <p className="text-xs leading-relaxed text-zinc-500">
          {t('私聊里点菜单按钮或 📖 就能打开。想在群里用，还要在 BotFather 的 /newapp 里把主 Mini App 设为：')}
          <span className="block break-all font-mono text-zinc-700 dark:text-zinc-300">{miniApp.url}</span>
        </p>
      ) : (
        <p className="text-xs text-zinc-500">{miniApp.reason ?? t('需要在扩展页的全局设置里填写公网地址（HTTPS）')}</p>
      )}
    </div>
  )
}

/** 管理 bot 能替主人在 Telegram 里新建 bot：点链接确认后，新 bot 自动接入并固定扮演选中的角色 */
function CreateManagedBot({ account }: { account: ChannelAccountDTO }) {
  const characters = useCharacters().data ?? []
  const link = useManagedBotLink()
  const [characterId, setCharacterId] = useState('')
  return (
    <div className="space-y-3 rounded-lg border border-violet-200 bg-violet-50/50 px-3 py-3 dark:border-violet-900 dark:bg-violet-950/30">
      <div>
        <h4 className="text-[13px] font-medium">{t('为角色新建一个 bot')}</h4>
        <p className="text-xs leading-relaxed text-zinc-500">
          {t('在 Telegram 里点一下确认，新 bot 就会出现在列表里，头像、名字和简介自动跟随角色。')}
        </p>
      </div>
      <div className="flex gap-2">
        <select
          aria-label={t('角色')}
          className={cx(selectClass, 'min-w-0 flex-1')}
          value={characterId}
          onChange={(e) => setCharacterId(e.target.value)}
        >
          <option value="">{t('选择角色')}</option>
          {characters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <Button
          variant="primary"
          disabled={!characterId || link.isPending}
          onClick={() =>
            link.mutate(
              { id: account.id, characterId },
              {
                onSuccess: ({ url }) => {
                  window.open(url, '_blank', 'noopener')
                  toast.info(t('已打开 Telegram，确认创建后回到这里'))
                },
                onError: (e) => toast.error(errorMessage(e)),
              },
            )
          }
        >
          {t('去 Telegram 创建')}
        </Button>
      </div>
    </div>
  )
}

function ManagedBotPanel({ account }: { account: ChannelAccountDTO }) {
  const accounts = useChannelAccounts().data ?? []
  const manager = accounts.find((a) => a.id === account.managedBy)
  const rotate = useRotateManagedBotToken()
  const access = useManagedBotAccess(account.id)
  const update = useUpdateManagedBotAccess()
  const [ids, setIds] = useState<string | null>(null)
  const restricted = access.data?.is_access_restricted ?? false
  const idText = ids ?? (access.data?.added_user_ids ?? []).join(', ')
  const parsed = idText
    .split(/[\s,，]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
  const save = (next: boolean) =>
    update.mutate(
      { id: account.id, restricted: next, addedUserIds: parsed },
      {
        onSuccess: () => {
          setIds(null)
          toast.info(t('已保存'))
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    )
  return (
    <div className="space-y-3 rounded-lg border border-zinc-200 px-3 py-3 dark:border-zinc-800">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="font-medium">{t('托管 bot')}</span>
        <span className="text-zinc-500">
          {t('由 {name} 创建和管理', {
            name: manager?.botUsername ? `@${manager.botUsername}` : (manager?.name ?? '?'),
          })}
        </span>
      </div>
      <SwitchField
        label={t('只允许指定的人使用')}
        hint={t('你自己始终可以用；最多再加 10 个 Telegram 用户 ID')}
        checked={restricted}
        disabled={access.isLoading || update.isPending}
        onChange={save}
      />
      {restricted && (
        <div className="flex gap-2">
          <input
            aria-label={t('允许的用户 ID')}
            className={cx(controlClass, 'min-w-0 flex-1 font-mono')}
            placeholder="12345678, 87654321"
            value={idText}
            onChange={(e) => setIds(e.target.value)}
          />
          <Button disabled={ids === null || update.isPending} onClick={() => save(true)}>
            {t('保存')}
          </Button>
        </div>
      )}
      <Button
        disabled={rotate.isPending}
        onClick={() =>
          rotate.mutate(account.id, {
            onSuccess: () => toast.info(t('已更换 Token，旧的立即失效')),
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      >
        {t('更换 Token')}
      </Button>
    </div>
  )
}

const presenceFields = () =>
  [
    { key: 'avatar', label: t('头像'), max: 0 },
    { key: 'name', label: t('名字'), max: 64 },
    { key: 'shortDescription', label: t('短简介'), max: 120 },
    { key: 'description', label: t('简介'), max: 512 },
  ] as const

function PresenceTab({
  account,
  presence,
  patch,
}: {
  account: ChannelAccountDTO
  presence: ChannelPresence
  patch: (p: Draft) => void
}) {
  const [previewing, setPreviewing] = useState(false)
  const preview = useChannelPresencePreview(previewing ? account.id : '')
  const apply = useApplyChannelPresence()
  const sync = useSyncChannelPresence()
  const characters = useCharacters().data ?? []
  const sourceId = account.characterMode === 'fixed' ? account.characterId : presence.characterId
  const source = characters.find((c) => c.id === sourceId)
  const setField = (key: (typeof presenceFields extends () => readonly (infer F)[] ? F : never)['key'], v: object) =>
    patch({ presence: { ...presence, [key]: { ...presence[key], ...v } } })
  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-zinc-500">
        {t(
          '平台上的头像、名字、简介是整个 bot 共用的，只能跟一个角色走。简介默认用角色卡里的「公开介绍」，不会上传完整角色设定。',
        )}
      </p>
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-zinc-200 px-3 py-3 dark:border-zinc-800">
        {account.characterMode === 'fixed' ? (
          <div className="flex items-center gap-2 text-[13px]">
            <Avatar name={source?.name ?? '?'} url={source?.avatarUrl ?? null} size={32} />
            <span>{t('跟随角色：{name}', { name: source?.name ?? t('未选择') })}</span>
          </div>
        ) : (
          <div className="w-72">
            <SelectField
              label={t('门面角色')}
              hint={t('通用 bot 在不同群扮演不同角色，资料只能跟一个')}
              value={presence.characterId ?? ''}
              onChange={(v) => patch({ presence: { ...presence, characterId: v || null } })}
              options={[
                { value: '', label: t('不跟随角色') },
                ...characters.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
          </div>
        )}
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={() => setPreviewing(true)}>
            {t('预览变化')}
          </Button>
          {account.presence.confirmed && (
            <Button
              variant="secondary"
              disabled={sync.isPending}
              onClick={() =>
                sync.mutate(account.id, {
                  onSuccess: () => toast.info(t('已开始同步')),
                  onError: (e) => toast.error(errorMessage(e)),
                })
              }
            >
              {t('立即同步')}
            </Button>
          )}
        </div>
      </div>
      <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {presenceFields().map((field) => {
          const value = presence[field.key]
          const capability = capabilityLabel(account.capabilities[field.key])
          const state = account.presenceSync[field.key]
          return (
            <li key={field.key} className="space-y-2 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-20 text-[13px] font-medium">{field.label}</span>
                {capability ? (
                  <span className={cx(badgeClass, 'font-normal text-amber-600')}>{capability}</span>
                ) : (
                  <select
                    aria-label={field.label}
                    className="h-8 rounded-lg border border-zinc-200 bg-white px-2 text-[13px] dark:border-zinc-700 dark:bg-zinc-900"
                    value={value.mode}
                    onChange={(e) => setField(field.key, { mode: e.target.value })}
                  >
                    <option value="follow-character">{t('跟随角色')}</option>
                    {field.key !== 'avatar' && <option value="custom">{t('自定义')}</option>}
                    <option value="unmanaged">{t('不管理')}</option>
                  </select>
                )}
                <span className="ml-auto text-xs text-zinc-500">
                  {state?.error
                    ? t('同步失败：{error}', { error: state.error })
                    : state?.appliedHash && state.appliedHash === state.desiredHash
                      ? t('已同步')
                      : value.mode !== 'unmanaged' && account.presence.confirmed
                        ? t('等待同步')
                        : ''}
                </span>
              </div>
              {value.mode === 'custom' && field.key !== 'avatar' && (
                <div className="space-y-2">
                  {field.key === 'description' ? (
                    <TextAreaField
                      label={t('内容')}
                      value={value.value}
                      onChange={(v) => setField(field.key, { value: v.slice(0, field.max) })}
                    />
                  ) : (
                    <TextField
                      label={t('内容')}
                      value={value.value}
                      onChange={(v) => setField(field.key, { value: v.slice(0, field.max) })}
                    />
                  )}
                  <details className="text-[13px]">
                    <summary className="cursor-pointer text-zinc-500">{t('按界面语言分别设置')}</summary>
                    <div className="grid gap-3 pt-2 sm:grid-cols-2">
                      {(['zh', 'en'] as const).map((lang) => (
                        <TextField
                          key={lang}
                          label={lang === 'zh' ? t('中文用户看到') : t('英文用户看到')}
                          value={value.languages[lang] ?? ''}
                          onChange={(v) =>
                            setField(field.key, {
                              languages: { ...value.languages, [lang]: v.slice(0, field.max) || undefined },
                            })
                          }
                        />
                      ))}
                    </div>
                  </details>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <Dialog open={previewing} onClose={() => setPreviewing(false)} title={t('平台资料变化')}>
        {preview.isLoading ? (
          <p className="text-sm text-zinc-500">{t('正在读取平台上的资料…')}</p>
        ) : preview.error ? (
          <p className="text-sm text-red-600">{errorMessage(preview.error)}</p>
        ) : preview.data ? (
          <div className="space-y-4">
            <p className="text-[13px] text-zinc-500">{t('保存修改后再预览，才会包含未保存的设置。')}</p>
            <table className="w-full text-left text-[13px]">
              <thead className="text-xs text-zinc-500">
                <tr>
                  <th className="w-20 py-1 font-normal" />
                  <th className="py-1 font-normal">{t('平台上现在')}</th>
                  <th className="py-1 font-normal">{t('同步后')}</th>
                </tr>
              </thead>
              <tbody className="align-top">
                {presenceFields().map((f) => {
                  const cur = preview.data.current[f.key] ?? ''
                  const next = preview.data.desired[f.key] ?? ''
                  const isImage = f.key === 'avatar'
                  return (
                    <tr key={f.key} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="py-2 text-zinc-500">{f.label}</td>
                      <td className="py-2 pr-3 break-words whitespace-pre-wrap">
                        {isImage && cur ? <img src={cur} alt="" className="size-12 rounded-full" /> : cur || '—'}
                      </td>
                      <td
                        className={cx(
                          'py-2 break-words whitespace-pre-wrap',
                          next && next !== cur && 'text-violet-700 dark:text-violet-300',
                        )}
                      >
                        {isImage && next ? (
                          <img src={next} alt="" className="size-12 rounded-full" />
                        ) : (
                          next || t('不变')
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {!preview.data.confirmed && (
              <div className="flex items-center justify-end gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                <span className="mr-auto text-xs text-zinc-500">{t('确认后，以后角色卡变化会自动同步到平台')}</span>
                <Button
                  variant="primary"
                  disabled={apply.isPending}
                  onClick={() =>
                    apply.mutate(
                      { id: account.id, confirm: true },
                      {
                        onSuccess: () => {
                          toast.info(t('已接管资料，正在同步'))
                          setPreviewing(false)
                        },
                        onError: (e) => toast.error(errorMessage(e)),
                      },
                    )
                  }
                >
                  {t('确认接管并同步')}
                </Button>
              </div>
            )}
          </div>
        ) : null}
      </Dialog>
    </div>
  )
}

function PoliciesTab({ account }: { account: ChannelAccountDTO }) {
  const [draft, setDraft] = useState<ChannelPolicies>(account.policies)
  const [ack, setAck] = useState(false)
  const save = useUpdateChannelPolicies()
  useEffect(() => setDraft(account.policies), [account.policies])
  const risky = draft.groupInvite === 'all' || draft.friendRequest === 'all'
  const wasRisky = account.policies.groupInvite === 'all' || account.policies.friendRequest === 'all'
  const needAck = risky && !wasRisky
  const dirty = JSON.stringify(draft) !== JSON.stringify(account.policies)
  const friendCapability = capabilityLabel(account.capabilities.friendRequest)
  const leaveCapability = capabilityLabel(account.capabilities.leaveGroup)
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="space-y-4 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <h4 className="text-[13px] font-medium">{t('被拉进群')}</h4>
          <SelectField
            label={t('有人把 bot 拉进新群时')}
            value={draft.groupInvite}
            onChange={(groupInvite) => setDraft({ ...draft, groupInvite })}
            options={[
              { value: 'approve', label: t('等我批准（会收到通知）') },
              { value: 'trusted', label: t('我或已授权的玩家拉就接受') },
              { value: 'all', label: t('谁拉都接受') },
              { value: 'never', label: t('从不，自动退出') },
            ]}
          />
          <NumberField
            label={t('最多加入几个群')}
            value={draft.limits.maxGroups}
            min={1}
            max={200}
            slider={false}
            onChange={(maxGroups) => setDraft({ ...draft, limits: { ...draft.limits, maxGroups } })}
          />
          <SelectField
            label={t('群里第一次有人说话')}
            value={draft.newLocation.group}
            onChange={(group) => setDraft({ ...draft, newLocation: { ...draft.newLocation, group } })}
            options={[
              { value: 'approve', label: t('等我批准') },
              { value: 'auto', label: t('自动开始') },
              { value: 'existing-only', label: t('只在已接好的群里说话') },
            ]}
          />
        </section>
        <section className="space-y-4 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <h4 className="text-[13px] font-medium">{t('私聊与好友')}</h4>
          <SelectField
            label={t('陌生人私聊')}
            hint={t('只有配对过的人或被授权的玩家才能让 AI 说话，陌生人只会收到配对提示')}
            value={draft.newLocation.private}
            onChange={(v) => setDraft({ ...draft, newLocation: { ...draft.newLocation, private: v } })}
            options={[
              { value: 'auto', label: t('自动开始') },
              { value: 'approve', label: t('等我批准') },
              { value: 'existing-only', label: t('只服务已有的私聊') },
            ]}
          />
          <SelectField
            label={t('好友请求')}
            hint={friendCapability ?? undefined}
            disabled={!!friendCapability}
            value={draft.friendRequest}
            onChange={(friendRequest) => setDraft({ ...draft, friendRequest })}
            options={[
              { value: 'paired', label: t('只接受配对过的人') },
              { value: 'all', label: t('接受所有人') },
              { value: 'never', label: t('从不接受') },
            ]}
          />
        </section>
      </div>
      <section className="space-y-4 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
        <SwitchField
          label={t('自动退出不活跃的群')}
          hint={leaveCapability ?? t('先通知我，过了宽限期还没人说话才退出')}
          disabled={!!leaveCapability}
          checked={draft.idleLeave.enabled}
          onChange={(enabled) => setDraft({ ...draft, idleLeave: { ...draft.idleLeave, enabled } })}
        />
        {draft.idleLeave.enabled && (
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              label={t('多少天没人说话算不活跃')}
              value={draft.idleLeave.idleDays}
              min={1}
              max={365}
              slider={false}
              onChange={(idleDays) => setDraft({ ...draft, idleLeave: { ...draft.idleLeave, idleDays } })}
            />
            <NumberField
              label={t('提醒后再等几天')}
              value={draft.idleLeave.graceDays}
              min={1}
              max={60}
              slider={false}
              onChange={(graceDays) => setDraft({ ...draft, idleLeave: { ...draft.idleLeave, graceDays } })}
            />
          </div>
        )}
      </section>
      {needAck && (
        <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          {t('我知道：任何人都能拉它进群或加好友，群里的对话会用我的模型额度')}
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" disabled={!dirty} onClick={() => setDraft(account.policies)}>
          {t('撤销')}
        </Button>
        <Button
          variant="primary"
          disabled={!dirty || (needAck && !ack) || save.isPending}
          onClick={() =>
            save.mutate(
              { id: account.id, policies: draft, ...(risky ? { confirm: true } : {}) },
              {
                onSuccess: () => {
                  setAck(false)
                  toast.info(t('已保存'))
                },
                onError: (e) => toast.error(errorMessage(e)),
              },
            )
          }
        >
          {t('保存')}
        </Button>
      </div>
    </div>
  )
}

function PersonaTab({ draft, patch }: { draft: ChannelAccountDTO & Draft; patch: (p: Draft) => void }) {
  const personas = usePersonas().data ?? []
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="space-y-4">
        <SelectField
          label={t('平台上的人在故事里叫什么')}
          hint={t('每个群或私聊还可以单独改')}
          value={draft.personaMode ?? 'platform-name'}
          onChange={(personaMode) => patch({ personaMode })}
          options={[...personaModeOptions()]}
        />
        {draft.personaMode === 'global' && (
          <>
            <SelectField
              label={t('共用的人设')}
              value={draft.globalPersonaId ?? ''}
              onChange={(v) => patch({ globalPersonaId: v || null })}
              options={[{ value: '', label: t('未选择') }, ...personas.map((p) => ({ value: p.id, label: p.name }))]}
            />
            <SwitchField
              label={t('锁定')}
              hint={t('锁定后其他人不能用 /persona 换成自己的')}
              checked={draft.personaLocked ?? false}
              onChange={(personaLocked) => patch({ personaLocked })}
            />
          </>
        )}
      </section>
      <section className="space-y-2 text-[13px] leading-relaxed text-zinc-500">
        <p>{t('用平台昵称：自动用对方的平台名字建一个简单人设，对方改名也会跟着改。')}</p>
        <p>{t('所有人共用：适合只有你自己用，或者大家一起扮演同一个主角。')}</p>
        <p>{t('每人自己选：配对过的人可以用自己 NoBot 账号里的人设；其他人发 /persona 名字 | 描述 自己写。')}</p>
        <p>{t('由我指定：在「群和私聊」里的成员列表给每个人选。')}</p>
      </section>
    </div>
  )
}

function BehaviorTab({
  value,
  onChange,
}: {
  value: ChannelSettingsOverride
  onChange: (v: ChannelSettingsOverride) => void
}) {
  const extension = useExtensions().data?.find((e) => e.id === 'channels')
  const global = channelSettingsSchema.parse(extension?.settings ?? {})
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-zinc-500">{t('这里的设置覆盖扩展页的全局默认；每个群或私聊还能再单独改。')}</p>
      <OverrideEditor value={value} effective={global} inheritedFrom={() => 'global'} onChange={onChange} />
    </div>
  )
}

function PlacesTab({ account, onOpen }: { account: ChannelAccountDTO; onOpen: (id: string) => void }) {
  const bindings = useChannelBindings(account.id).data ?? []
  if (bindings.length === 0)
    return (
      <p className="py-8 text-center text-sm text-zinc-500">
        {t('还没有群或私聊。把 bot 拉进群，或者私聊它说句话，这里就会出现。')}
      </p>
    )
  const sorted = [...bindings].sort(
    (a, b) => Number(b.state === 'pending') - Number(a.state === 'pending') || b.lastActivityAt - a.lastActivityAt,
  )
  return (
    <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
      {sorted.map((b) => {
        const state = stateMeta(b.state)
        return (
          <li key={b.id}>
            <button
              type="button"
              onClick={() => onOpen(b.id)}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
            >
              <Avatar name={b.title || b.chat} size={32} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium">{b.title || b.chat}</span>
                  <span className={cx(badgeClass, 'font-normal')}>{scopeLabel(b)}</span>
                  {b.scope === 'group' && (
                    <span className={cx(badgeClass, 'font-normal text-zinc-500')}>{isolationLabel(b.isolation)}</span>
                  )}
                </span>
                <span className="block truncate text-xs text-zinc-500">
                  {[b.chatTitle, b.scope === 'group' && t('{n} 人', { n: b.memberCount }), timeAgo(b.lastActivityAt)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <span className={cx('shrink-0 text-xs', state.cls)}>{state.label}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
