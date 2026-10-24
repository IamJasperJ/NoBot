import type {
  ChannelAccountDTO,
  ChannelBindingDTO,
  ChannelCapabilityState,
  ChannelSettings,
  ChannelSettingsOverride,
} from '../../api/channels'
import { Toggle } from '../../components/form'
import { RefreshIcon } from '../../components/icons'
import { badgeClass, controlClass, cx, IconButton, selectClass } from '../../components/ui'
import { t } from '../../i18n'

export const providerLabel = (p: ChannelAccountDTO['provider']) => (p === 'telegram' ? 'Telegram' : 'QQ（NapCat）')

export const statusMeta = (s: ChannelAccountDTO['status']) =>
  ({
    online: { label: t('在线'), dot: 'bg-emerald-500' },
    connecting: { label: t('连接中'), dot: 'bg-amber-500' },
    error: { label: t('出错'), dot: 'bg-red-500' },
    stopped: { label: t('已停止'), dot: 'bg-zinc-400' },
  })[s]

export const capabilityLabel = (s: ChannelCapabilityState | undefined) =>
  s === 'supported'
    ? null
    : s === 'console_only'
      ? t('需在平台后台修改')
      : s === 'permission_required'
        ? t('需要群管理权限')
        : s === 'unsupported'
          ? t('平台不支持')
          : t('未确认')

export const scopeLabel = (b: ChannelBindingDTO) => (b.scope === 'private' ? t('私聊') : b.thread ? t('话题') : t('群'))

export const isolationLabel = (v: ChannelBindingDTO['isolation']) =>
  ({ dm: t('私聊'), shared: t('群共享'), 'per-user': t('每人各自'), 'per-topic': t('按话题') })[v]

export const stateMeta = (v: ChannelBindingDTO['state']) =>
  ({
    active: { label: t('使用中'), cls: 'text-emerald-600 dark:text-emerald-400' },
    pending: { label: t('待批准'), cls: 'text-amber-600 dark:text-amber-400' },
    disabled: { label: t('已停用'), cls: 'text-zinc-500' },
    left: { label: t('已退出'), cls: 'text-zinc-500' },
  })[v]

export const triggerOptions = () =>
  [
    { value: 'follow-room', label: t('跟随房间回合方式') },
    { value: 'mention', label: t('被 @ 时') },
    { value: 'reply', label: t('回复它的消息时') },
    { value: 'command', label: t('只响应命令') },
    { value: 'all', label: t('每条消息') },
  ] as const

export const personaModeOptions = () =>
  [
    { value: 'platform-name', label: t('用平台昵称') },
    { value: 'global', label: t('所有人共用一个人设') },
    { value: 'per-actor', label: t('每人自己选（/persona）') },
    { value: 'owner-assigned', label: t('由我指定') },
  ] as const

type Kind =
  | { type: 'bool' }
  | { type: 'select'; options: { value: string; label: string }[] }
  | { type: 'number'; min: number; max: number }
type Row = { key: keyof ChannelSettings; label: string; kind: Kind }

/** 行为设置分组；每层（全局 → 机器人 → 位置）都用同一份清单 */
export const settingGroups = (): { title: string; rows: Row[] }[] => [
  {
    title: t('输出'),
    rows: [
      { key: 'stream', label: t('流式输出'), kind: { type: 'bool' } },
      { key: 'streamIntervalMs', label: t('更新间隔（毫秒）'), kind: { type: 'number', min: 250, max: 60000 } },
      {
        key: 'thinking',
        label: t('思考过程'),
        kind: {
          type: 'select',
          options: [
            { value: 'omit', label: t('不发') },
            { value: 'fold', label: t('折叠显示') },
          ],
        },
      },
      {
        key: 'queueMode',
        label: t('生成中又收到消息'),
        kind: {
          type: 'select',
          options: [
            { value: 'merge', label: t('排队合并') },
            { value: 'interrupt', label: t('打断重来') },
          ],
        },
      },
    ],
  },
  {
    title: t('消息下方的按钮'),
    rows: [
      { key: 'regenerateButton', label: t('重新生成'), kind: { type: 'bool' } },
      { key: 'previousButton', label: t('上一个回复'), kind: { type: 'bool' } },
      { key: 'nextButton', label: t('下一个回复'), kind: { type: 'bool' } },
      { key: 'continueButton', label: t('续写'), kind: { type: 'bool' } },
      { key: 'deleteButton', label: t('删除'), kind: { type: 'bool' } },
    ],
  },
  {
    title: t('同步与提醒'),
    rows: [
      { key: 'mirrorWebMessages', label: t('网页上发的消息同步到平台'), kind: { type: 'bool' } },
      { key: 'personaPrefix', label: t('同步时带人设名'), kind: { type: 'bool' } },
      { key: 'deleteSync', label: t('平台上删消息时也删 NoBot 记录'), kind: { type: 'bool' } },
      { key: 'mentionOnTurn', label: t('轮到某人时在群里 @ 他'), kind: { type: 'bool' } },
      { key: 'actorRateLimit', label: t('每人每分钟最多消息数'), kind: { type: 'number', min: 1, max: 1000 } },
    ],
  },
  {
    title: t('轻互动'),
    rows: [
      { key: 'reactions', label: t('角色给消息回表情'), kind: { type: 'bool' } },
      { key: 'reactionCooldownMs', label: t('冷却（毫秒）'), kind: { type: 'number', min: 1000, max: 3600000 } },
      { key: 'reactionDailyBudget', label: t('每天最多次数'), kind: { type: 'number', min: 0, max: 1000 } },
    ],
  },
]

const sourceLabel = (s: 'global' | 'account' | 'binding') =>
  s === 'global' ? t('继承全局') : s === 'account' ? t('继承机器人') : t('本处设置')

/**
 * 分层设置编辑器：没覆盖的项显示继承来的值（灰色徽标标明来源），改了就写进本层；↺ 清除本层覆盖。
 */
export function OverrideEditor({
  value,
  effective,
  inheritedFrom,
  onChange,
  disabled,
}: {
  /** 本层的覆盖值 */
  value: ChannelSettingsOverride
  /** 没覆盖时显示的值 */
  effective: ChannelSettings
  /** 没覆盖时值的来源 */
  inheritedFrom: (key: keyof ChannelSettings) => 'global' | 'account' | 'binding'
  onChange: (next: ChannelSettingsOverride) => void
  disabled?: boolean
}) {
  const set = (key: keyof ChannelSettings, v: unknown) => onChange({ ...value, [key]: v })
  const reset = (key: keyof ChannelSettings) => {
    const next = { ...value }
    delete next[key]
    onChange(next)
  }
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {settingGroups().map((group) => (
        <section
          key={group.title}
          className="rounded-xl border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/40"
        >
          <h4 className="pb-1 text-xs font-medium text-zinc-500">{group.title}</h4>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {group.rows.map((row) => {
              const own = value[row.key] !== undefined
              const current = (own ? value[row.key] : effective[row.key]) as boolean | number | string
              return (
                <li key={row.key} className="flex min-h-11 items-center gap-2 py-1.5">
                  <span className="min-w-0 flex-1 text-[13px]">{row.label}</span>
                  {own ? (
                    <IconButton label={t('恢复继承')} onClick={() => reset(row.key)} disabled={disabled}>
                      <RefreshIcon />
                    </IconButton>
                  ) : (
                    <span className={cx(badgeClass, 'font-normal text-zinc-400')}>
                      {sourceLabel(inheritedFrom(row.key))}
                    </span>
                  )}
                  <div className={cx('shrink-0', !own && 'opacity-60')}>
                    {row.kind.type === 'bool' ? (
                      <Toggle
                        label={row.label}
                        checked={current as boolean}
                        disabled={disabled}
                        onChange={(v) => set(row.key, v)}
                      />
                    ) : row.kind.type === 'select' ? (
                      <select
                        aria-label={row.label}
                        className={cx(selectClass, 'w-32')}
                        value={current as string}
                        disabled={disabled}
                        onChange={(e) => set(row.key, e.target.value)}
                      >
                        {row.kind.options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="number"
                        aria-label={row.label}
                        className={cx(controlClass, 'w-28')}
                        min={row.kind.min}
                        max={row.kind.max}
                        value={current as number}
                        disabled={disabled}
                        onChange={(e) => {
                          const kind = row.kind as { min: number; max: number }
                          const n = Number(e.target.value)
                          if (Number.isFinite(n)) set(row.key, Math.min(kind.max, Math.max(kind.min, Math.round(n))))
                        }}
                      />
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

export const timeAgo = (at: number) => {
  const s = Math.max(0, (Date.now() - at) / 1000)
  if (s < 60) return t('刚刚')
  if (s < 3600) return t('{n} 分钟前', { n: Math.floor(s / 60) })
  if (s < 86400) return t('{n} 小时前', { n: Math.floor(s / 3600) })
  return t('{n} 天前', { n: Math.floor(s / 86400) })
}
