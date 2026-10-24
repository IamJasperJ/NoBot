import { useState } from 'react'
import {
  type ChannelAccountDTO,
  useChannelAccountAction,
  useChannelAccounts,
  useChannelLog,
  useChannelRequests,
  useConfirmChannelPairing,
  useCreateChannelAccount,
  useDeleteChannelAccount,
  useRespondChannelRequest,
} from '../../api/channels'
import { useCharacters } from '../../api/queries'
import { SelectField, Tabs, TextField } from '../../components/form'
import {
  BanIcon,
  CheckIcon,
  LinkIcon,
  PlayIcon,
  PlusIcon,
  RefreshIcon,
  StopIcon,
  TrashIcon,
  XIcon,
} from '../../components/icons'
import { Menu, MenuDivider, MenuEntry } from '../../components/menu'
import { Avatar, Button, badgeClass, controlClass, cx, Dialog } from '../../components/ui'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'
import { AccountDialog } from './AccountDialog'
import { providerLabel, statusMeta, timeAgo } from './shared'

/** 渠道扩展详情页顶部：机器人列表、待处理请求、配对。全局默认设置仍由扩展页的设置编辑器负责 */
export function ChannelsManager() {
  const accounts = useChannelAccounts()
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const open = accounts.data?.find((a) => a.id === openId) ?? null
  return (
    <div className="space-y-3">
      <PendingRequests accounts={accounts.data ?? []} />
      <section className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40">
        <header className="flex items-center gap-2 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
          <h3 className="text-sm font-semibold">{t('机器人')}</h3>
          <span className="text-xs text-zinc-500">
            {t('Telegram 或 QQ（NapCat）；每个 bot 可以固定扮演一个角色，也可以当通用 bot')}
          </span>
          <Button size="sm" variant="primary" className="ml-auto" onClick={() => setCreating(true)}>
            <PlusIcon />
            {t('添加')}
          </Button>
        </header>
        {accounts.isLoading ? (
          <p className="px-3 py-6 text-center text-sm text-zinc-500">{t('加载中…')}</p>
        ) : (accounts.data ?? []).length === 0 ? (
          <div className="space-y-2 px-3 py-6 text-center text-[13px] text-zinc-500">
            <p>{t('还没有机器人。')}</p>
            <p>{t('Telegram：找 @BotFather 发 /newbot 拿 Token；QQ：先装好 NapCat。')}</p>
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {(accounts.data ?? []).map((a) => (
              <AccountRow key={a.id} account={a} onOpen={() => setOpenId(a.id)} />
            ))}
          </ul>
        )}
      </section>
      <PairingCard />
      <LogCard />
      <CreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false)
          setOpenId(id)
        }}
      />
      <AccountDialog account={open} onClose={() => setOpenId(null)} />
    </div>
  )
}

function AccountRow({ account, onOpen }: { account: ChannelAccountDTO; onOpen: () => void }) {
  const action = useChannelAccountAction()
  const remove = useDeleteChannelAccount()
  const characters = useCharacters().data ?? []
  const status = statusMeta(account.status)
  const character = characters.find((c) => c.id === (account.characterId ?? account.presence.characterId))
  const run = (a: 'start' | 'stop' | 'restart') =>
    action.mutate({ id: account.id, action: a }, { onError: (e) => toast.error(errorMessage(e)) })
  const running = account.status === 'online' || account.status === 'connecting'
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="relative">
          <Avatar name={character?.name ?? account.name} url={character?.avatarUrl ?? null} size={40} />
          <span
            className={cx(
              'absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-white dark:ring-zinc-900',
              status.dot,
            )}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium">{account.name}</span>
            {account.botUsername && (
              <span className="truncate font-mono text-xs text-zinc-500">@{account.botUsername}</span>
            )}
            {(account.pendingRequestCount ?? 0) > 0 && (
              <span className="rounded-full bg-red-500 px-1.5 text-[11px] text-white">
                {account.pendingRequestCount}
              </span>
            )}
          </span>
          <span className="block truncate text-xs text-zinc-500">
            {[
              providerLabel(account.provider),
              status.label,
              account.characterMode === 'fixed'
                ? t('扮演 {name}', { name: character?.name ?? t('未选择角色') })
                : t('通用 bot'),
              t('{n} 个群或私聊', { n: account.bindingCount ?? 0 }),
            ].join(' · ')}
          </span>
          {account.status === 'error' && account.lastError && (
            <span className="block truncate text-xs text-red-600">{account.lastError}</span>
          )}
        </span>
      </button>
      {running ? (
        <Button size="sm" disabled={action.isPending} onClick={() => run('stop')}>
          <StopIcon />
          {t('停止')}
        </Button>
      ) : (
        <Button size="sm" disabled={action.isPending} onClick={() => run('start')}>
          <PlayIcon />
          {t('启动')}
        </Button>
      )}
      <Menu>
        <MenuEntry icon={<RefreshIcon />} onClick={() => run('restart')}>
          {t('重新连接')}
        </MenuEntry>
        <MenuDivider />
        <MenuEntry
          icon={<TrashIcon />}
          danger
          onClick={() =>
            remove.mutate(account.id, {
              onSuccess: () => toast.info(t('已删除机器人，会话和房间保留')),
              onError: (e) => toast.error(errorMessage(e)),
            })
          }
        >
          {t('删除')}
        </MenuEntry>
      </Menu>
    </li>
  )
}

function CreateDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const characters = useCharacters().data ?? []
  const create = useCreateChannelAccount()
  const empty = {
    provider: 'telegram' as 'telegram' | 'onebot11',
    name: '',
    token: '',
    mode: 'ws-forward' as 'ws-forward' | 'ws-reverse',
    url: 'ws://127.0.0.1:3001',
    characterMode: 'fixed' as 'fixed' | 'generic',
    characterId: '',
  }
  const [form, setForm] = useState(empty)
  const qq = form.provider === 'onebot11'
  const ready =
    form.token.trim() &&
    (form.characterMode === 'generic' || form.characterId) &&
    (!qq || form.mode === 'ws-reverse' || /^wss?:\/\//.test(form.url.trim()))
  const submit = () => {
    const character = characters.find((c) => c.id === form.characterId)
    const base = {
      name: form.name.trim() || character?.name || (qq ? 'QQ' : 'Telegram'),
      characterMode: form.characterMode,
      characterId: form.characterMode === 'fixed' ? form.characterId : null,
    }
    create.mutate(
      qq
        ? {
            ...base,
            provider: 'onebot11',
            credentials: { accessToken: form.token.trim() },
            connection: { mode: form.mode, url: form.mode === 'ws-forward' ? form.url.trim() : '' },
            receiveMode: form.mode,
          }
        : { ...base, provider: 'telegram', credentials: { token: form.token.trim() } },
      {
        onSuccess: (account) => {
          setForm(empty)
          toast.info(
            account.botUsername
              ? t('已连接 @{name}', { name: account.botUsername })
              : t('已添加 {name}', { name: account.name }),
          )
          onCreated(account.id)
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    )
  }
  return (
    <Dialog open={open} onClose={onClose} title={t('添加机器人')} className="w-[min(560px,calc(100vw-32px))]">
      <div className="space-y-4">
        <Tabs
          value={form.provider}
          onChange={(provider) => setForm({ ...form, provider })}
          tabs={[
            { id: 'telegram', label: 'Telegram' },
            { id: 'onebot11', label: t('QQ（NapCat）') },
          ]}
        />
        {qq ? (
          <>
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
              {t('NapCat 是非官方的 QQ 客户端，QQ 号有被风控或封禁的风险。建议用专门的小号，不要用常用号。')}
            </p>
            <ol className="list-decimal space-y-1 pl-5 text-[13px] text-zinc-500">
              <li>{t('安装并登录 NapCat，在它的网络设置里新建一个 WebSocket 连接')}</li>
              <li>{t('选「NoBot 连 NapCat」就建 WebSocket 服务端；选「NapCat 连 NoBot」就建 WebSocket 客户端')}</li>
              <li>{t('两边填同一个 Token')}</li>
            </ol>
            <SelectField
              label={t('连接方向')}
              value={form.mode}
              onChange={(mode) => setForm({ ...form, mode })}
              options={[
                { value: 'ws-forward', label: t('NoBot 连 NapCat（正向 WebSocket）') },
                { value: 'ws-reverse', label: t('NapCat 连 NoBot（反向 WebSocket）') },
              ]}
            />
            {form.mode === 'ws-forward' ? (
              <TextField
                label={t('NapCat 的 WebSocket 地址')}
                placeholder="ws://127.0.0.1:3001"
                value={form.url}
                onChange={(url) => setForm({ ...form, url })}
              />
            ) : (
              <p className="text-xs text-zinc-500">{t('创建后会显示要填进 NapCat 的地址。')}</p>
            )}
            <TextField
              label={t('Access Token')}
              type="password"
              value={form.token}
              onChange={(token) => setForm({ ...form, token })}
            />
          </>
        ) : (
          <>
            <ol className="list-decimal space-y-1 pl-5 text-[13px] text-zinc-500">
              <li>{t('在 Telegram 里打开 @BotFather，发 /newbot，按提示起名字')}</li>
              <li>{t('复制它给你的 Token，粘贴到下面')}</li>
              <li>{t('想让 bot 在群里听到所有消息，在 BotFather 里 /setprivacy 关掉隐私模式')}</li>
            </ol>
            <TextField
              label={t('Bot Token')}
              type="password"
              placeholder="123456:ABC-DEF…"
              value={form.token}
              onChange={(token) => setForm({ ...form, token })}
            />
          </>
        )}
        <SelectField
          label={t('扮演方式')}
          value={form.characterMode}
          onChange={(characterMode) => setForm({ ...form, characterMode })}
          options={[
            { value: 'fixed', label: t('一角色一 bot') },
            { value: 'generic', label: t('通用 bot') },
          ]}
        />
        {form.characterMode === 'fixed' && (
          <SelectField
            label={t('角色')}
            value={form.characterId}
            onChange={(characterId) => setForm({ ...form, characterId })}
            options={[{ value: '', label: t('选择角色') }, ...characters.map((c) => ({ value: c.id, label: c.name }))]}
          />
        )}
        <TextField
          label={t('名称')}
          hint={t('只在 NoBot 里显示，不填就用角色名')}
          value={form.name}
          onChange={(name) => setForm({ ...form, name })}
        />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('取消')}</Button>
          <Button variant="primary" disabled={!ready || create.isPending} onClick={submit}>
            {create.isPending ? t('正在验证…') : t('连接')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function PendingRequests({ accounts }: { accounts: ChannelAccountDTO[] }) {
  const requests = (useChannelRequests().data ?? []).filter((r) => r.state === 'pending')
  const respond = useRespondChannelRequest()
  if (requests.length === 0) return null
  const name = (id: string) => {
    const a = accounts.find((x) => x.id === id)
    return a?.botUsername ? `@${a.botUsername}` : (a?.name ?? '')
  }
  const kindText = (kind: string, actor: string | null | undefined) =>
    kind === 'group-invite'
      ? actor
        ? t('{name} 把 bot 拉进了群', { name: actor })
        : t('bot 被拉进了群')
      : kind === 'friend'
        ? t('{name} 想加好友', { name: actor ?? '?' })
        : kind === 'join-request'
          ? t('{name} 申请加入群', { name: actor ?? '?' })
          : actor
            ? t('{name} 第一次在这里说话', { name: actor })
            : t('新的聊天位置')
  const act = (id: string, action: 'approve' | 'reject' | 'block') =>
    respond.mutate({ id, action }, { onError: (e) => toast.error(errorMessage(e)) })
  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30">
      <h3 className="px-3 pt-2 text-[13px] font-semibold text-amber-800 dark:text-amber-300">
        {t('等你处理（{n}）', { n: requests.length })}
      </h3>
      <ul className="divide-y divide-amber-100 dark:divide-amber-900/50">
        {requests.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{r.title}</span>
              <span className="block truncate text-xs text-zinc-500">
                {[kindText(r.kind, r.actorName), name(r.accountId), timeAgo(r.createdAt)].join(' · ')}
              </span>
            </span>
            <Button size="sm" variant="primary" onClick={() => act(r.id, 'approve')}>
              <CheckIcon />
              {t('同意')}
            </Button>
            <Button size="sm" onClick={() => act(r.id, 'reject')}>
              <XIcon />
              {r.kind === 'group-invite' ? t('拒绝并退群') : t('拒绝')}
            </Button>
            <Button size="sm" variant="danger" onClick={() => act(r.id, 'block')}>
              <BanIcon />
              {t('拉黑')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function PairingCard() {
  const [code, setCode] = useState('')
  const confirm = useConfirmChannelPairing()
  return (
    <section className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/40">
      <LinkIcon />
      <div className="min-w-0 flex-1">
        <h3 className="text-[13px] font-medium">{t('绑定我的平台账号')}</h3>
        <p className="text-xs text-zinc-500">
          {t('私聊你的 bot 发 /start，把它回的 6 位配对码填在这里。配对后你就是 bot 的主人。')}
        </p>
      </div>
      <input
        aria-label={t('配对码')}
        inputMode="numeric"
        maxLength={6}
        placeholder="123456"
        className={cx(controlClass, 'w-28 text-center font-mono tracking-widest')}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
      />
      <Button
        variant="primary"
        disabled={code.length !== 6 || confirm.isPending}
        onClick={() =>
          confirm.mutate(code, {
            onSuccess: (actor) => {
              setCode('')
              toast.info(t('已绑定 {name}', { name: actor.displayName }))
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      >
        {t('确认')}
      </Button>
    </section>
  )
}

function LogCard() {
  const [open, setOpen] = useState(false)
  const log = useChannelLog()
  return (
    <details
      className="rounded-xl border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/40"
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-[13px] font-medium">{t('最近记录')}</summary>
      {open && (
        <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto font-mono text-xs">
          {(log.data ?? []).length === 0 && <li className="text-zinc-500">{t('暂无记录')}</li>}
          {(log.data ?? []).map((entry, i) => (
            <li key={`${entry.at}-${i}`} className="flex gap-2">
              <span className="shrink-0 text-zinc-400">{new Date(entry.at).toLocaleTimeString()}</span>
              <span className={cx(badgeClass, 'shrink-0 font-normal')}>{entry.code}</span>
              <span className="min-w-0 break-words">{entry.message}</span>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}
