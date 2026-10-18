import { type QuickReply, type QuickReplySet, quickReplyEvents } from '@ai-parter/shared'
import { type ReactNode, useRef, useState } from 'react'
import { Section, SwitchField, TextAreaField, TextField } from '../../components/form'
import { ChevronDownIcon, PlusIcon, TrashIcon, UploadIcon } from '../../components/icons'
import { DetailHeader, ListItem } from '../../components/layout'
import { Button, badgeClass, controlClass, cx, IconButton } from '../../components/ui'
import { t } from '../../i18n'
import { useQuickReplyMutations, useQuickReplySets } from '../../quick-replies/hooks'
import { importQuickReplySet } from '../../quick-replies/logic'
import { errorMessage, toast } from '../../stores/toast'

type Draft = Omit<QuickReplySet, 'id'>
const toDraft = ({ id: _id, ...set }: QuickReplySet): Draft => structuredClone(set)

const EVENT_LABELS = (): Record<(typeof quickReplyEvents)[number], string> => ({
  onStartup: t('打开应用时'),
  onUser: t('发出消息后'),
  onAi: t('角色回复后'),
  onChatChange: t('切换会话时'),
  onGroupMemberDraft: t('群聊轮到成员时'),
  onNewChat: t('新建会话时'),
})

const newButton = (): QuickReply => ({
  id: crypto.randomUUID(),
  label: t('新按钮'),
  title: '',
  message: '',
  isHidden: false,
  autoExecute: {
    onStartup: false,
    onUser: false,
    onAi: false,
    onChatChange: false,
    onGroupMemberDraft: false,
    onNewChat: false,
  },
})

/**
 * 设置页里的「快速回复」（对应酒馆的 Quick Reply）：列表在侧栏，选中后在右侧编辑。
 * 一组快速回复 = 一排按钮；「全局启用」的组在所有会话都显示，也可以在角色或会话里单独启用
 */
export function useQuickReplyPanel(): { list: ReactNode; detail: ReactNode; open: boolean } {
  const query = useQuickReplySets()
  const m = useQuickReplyMutations()
  const [originalId, setOriginalId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const sets = query.data?.sets ?? []
  const globalIds = query.data?.setIds ?? []
  const original = sets.find((s) => s.id === originalId) ?? null
  const dirty = !!draft && !!original && JSON.stringify(draft) !== JSON.stringify(toDraft(original))
  const busy = m.create.isPending || m.update.isPending || m.remove.isPending || m.global.isPending
  const canLeave = () => !dirty || confirm(t('这组快速回复有未保存的修改，是否放弃？'))
  const pick = (set: QuickReplySet | null) => {
    setOriginalId(set?.id ?? null)
    setDraft(set ? toDraft(set) : null)
  }
  const fail = { onError: (e: unknown) => toast.error(errorMessage(e)) }

  const list = (
    <section className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40">
      <header className="flex items-center gap-1 py-1.5 pr-1.5 pl-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{t('快速回复')}</h2>
          <p className="truncate text-xs text-zinc-500">{t('输入框上方的一排按钮，可以发消息或执行命令')}</p>
        </div>
        <IconButton
          label={t('导入酒馆的快速回复组（JSON）')}
          disabled={busy}
          onClick={() => {
            if (canLeave()) fileInput.current?.click()
          }}
        >
          <UploadIcon />
        </IconButton>
        <IconButton
          label={t('新建快速回复组')}
          disabled={busy}
          onClick={() => {
            if (canLeave())
              m.create.mutate({ name: t('新的快速回复'), buttons: [newButton()] }, { ...fail, onSuccess: pick })
          }}
        >
          <PlusIcon />
        </IconButton>
        <input
          ref={fileInput}
          type="file"
          accept=".json"
          className="hidden"
          aria-label={t('导入快速回复文件')}
          onChange={async (event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (!file) return
            try {
              const input = importQuickReplySet(JSON.parse(await file.text()))
              m.create.mutate(input, {
                ...fail,
                onSuccess: (saved) => {
                  pick(saved)
                  toast.info(t('已导入快速回复组'))
                },
              })
            } catch (e) {
              toast.error(errorMessage(e))
            }
          }}
        />
      </header>
      <div className="border-t border-zinc-100 p-1 dark:border-zinc-800">
        {query.isPending && <p className="px-2 py-1.5 text-sm text-zinc-500">{t('加载中…')}</p>}
        {!query.isPending && !sets.length && (
          <p className="px-2 py-1.5 text-xs text-zinc-500">{t('还没有快速回复组')}</p>
        )}
        {sets.map((set) => (
          <ListItem
            key={set.id}
            active={set.id === originalId}
            onClick={() => {
              if (!busy && set.id !== originalId && canLeave()) pick(set)
            }}
          >
            <span className="min-w-0 flex-1 truncate">{set.name}</span>
            <span className="shrink-0 text-xs text-zinc-400 tabular-nums">{set.buttons.length}</span>
            {globalIds.includes(set.id) && (
              <span className={cx(badgeClass, 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300')}>
                {t('全局')}
              </span>
            )}
          </ListItem>
        ))}
      </div>
    </section>
  )

  const patchButton = (i: number, patch: Partial<QuickReply>) =>
    draft && setDraft({ ...draft, buttons: draft.buttons.map((b, j) => (j === i ? { ...b, ...patch } : b)) })
  const moveButton = (i: number, delta: -1 | 1) => {
    if (!draft) return
    const buttons = [...draft.buttons]
    const [item] = buttons.splice(i, 1)
    if (item) buttons.splice(i + delta, 0, item)
    setDraft({ ...draft, buttons })
  }

  const detail =
    draft && original ? (
      <>
        <DetailHeader
          title={
            <input
              aria-label={t('快速回复组名称')}
              className={cx(controlClass, 'h-8 max-w-md min-w-0 font-semibold')}
              value={draft.name}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          }
          onBack={() => {
            if (!busy && canLeave()) pick(null)
          }}
          actions={
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="ghost" disabled={busy || !dirty} onClick={() => setDraft(toDraft(original))}>
                {t('撤销修改')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={busy || !dirty || !draft.name.trim()}
                onClick={() =>
                  m.update.mutate(
                    { id: original.id, input: { ...draft, name: draft.name.trim() } },
                    {
                      ...fail,
                      onSuccess: (saved) => {
                        pick(saved)
                        toast.info(t('已保存'))
                      },
                    },
                  )
                }
              >
                {t('保存')}
              </Button>
              <IconButton
                variant="danger"
                label={t('删除这组快速回复')}
                disabled={busy}
                onClick={() => {
                  if (confirm(t('删除快速回复组「{name}」？', { name: original.name })))
                    m.remove.mutate(original.id, { ...fail, onSuccess: () => pick(null) })
                }}
              >
                <TrashIcon />
              </IconButton>
            </div>
          }
        />
        <div className="space-y-2 p-3">
          <Section dense title={t('这组按钮')}>
            <SwitchField
              label={t('全局启用')}
              hint={t('在所有会话的输入框上方显示。也可以只在某个角色或会话里启用（角色编辑页、会话设置）')}
              checked={globalIds.includes(original.id)}
              onChange={(on) =>
                m.global.mutate(on ? [...globalIds, original.id] : globalIds.filter((id) => id !== original.id), fail)
              }
            />
            <SwitchField
              label={t('只填进输入框')}
              hint={t('点按钮时把内容放进输入框，不直接发送（命令照常执行）')}
              checked={draft.disableSend ?? false}
              onChange={(disableSend) => setDraft({ ...draft, disableSend })}
            />
            <SwitchField
              label={t('放在输入内容前面')}
              hint={t('输入框里已经有字时，按钮内容插到前面；关闭则接在后面')}
              checked={draft.placeBeforeInput ?? false}
              onChange={(placeBeforeInput) => setDraft({ ...draft, placeBeforeInput })}
            />
            <SwitchField
              label={t('带上输入框内容')}
              hint={t('发送时把输入框里的文字一起带上；也可以在内容里用 {{input}} 指定位置')}
              checked={draft.injectInput ?? false}
              onChange={(injectInput) => setDraft({ ...draft, injectInput })}
            />
          </Section>
          {draft.buttons.map((qr, i) => (
            <ButtonEditor
              key={qr.id}
              qr={qr}
              first={i === 0}
              last={i === draft.buttons.length - 1}
              onChange={(patch) => patchButton(i, patch)}
              onMove={(delta) => moveButton(i, delta)}
              onRemove={() => setDraft({ ...draft, buttons: draft.buttons.filter((_, j) => j !== i) })}
            />
          ))}
          <Button size="sm" onClick={() => setDraft({ ...draft, buttons: [...draft.buttons, newButton()] })}>
            <PlusIcon />
            {t('添加按钮')}
          </Button>
        </div>
      </>
    ) : null

  return { list, detail, open: !!draft }
}

/** 一个按钮的编辑卡片：标签、内容、提示、隐藏、自动执行、自动化标识 */
function ButtonEditor({
  qr,
  first,
  last,
  onChange,
  onMove,
  onRemove,
}: {
  qr: QuickReply
  first: boolean
  last: boolean
  onChange: (patch: Partial<QuickReply>) => void
  onMove: (delta: -1 | 1) => void
  onRemove: () => void
}) {
  const [advanced, setAdvanced] = useState(false)
  const autoCount = Object.values(qr.autoExecute).filter(Boolean).length
  return (
    <div className="space-y-2 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex items-center gap-1.5">
        <input
          aria-label={t('按钮文字')}
          className={cx(controlClass, 'h-8 min-w-0 flex-1 font-medium')}
          value={qr.label}
          onChange={(e) => onChange({ label: e.target.value })}
        />
        <IconButton label={t('上移')} disabled={first} onClick={() => onMove(-1)}>
          <ChevronDownIcon className="rotate-180" />
        </IconButton>
        <IconButton label={t('下移')} disabled={last} onClick={() => onMove(1)}>
          <ChevronDownIcon />
        </IconButton>
        <IconButton variant="danger" label={t('删除这个按钮')} onClick={onRemove}>
          <TrashIcon />
        </IconButton>
      </div>
      <TextAreaField
        label={t('内容')}
        hint={t(
          '普通文字会作为你的消息发出；以 / 开头就当命令执行，可以用 | 串起多条，比如 /roll 1d20 | /sys 结果是 {{pipe}}',
        )}
        mono={qr.message.trimStart().startsWith('/')}
        rows={3}
        value={qr.message}
        onChange={(message) => onChange({ message })}
      />
      <button
        type="button"
        className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
        onClick={() => setAdvanced(!advanced)}
      >
        <ChevronDownIcon className={cx('size-3.5 transition-transform', advanced && 'rotate-180')} />
        {t('更多设置')}
        {autoCount > 0 && <span className="text-violet-600">{t('（{count} 个自动执行）', { count: autoCount })}</span>}
      </button>
      {advanced && (
        <div className="space-y-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label={t('鼠标悬停提示')} value={qr.title} onChange={(title) => onChange({ title })} />
            <TextField
              label={t('自动化标识')}
              hint={t('世界书条目的「自动化标识」和这里相同时，条目被触发后自动执行这个按钮')}
              value={qr.automationId ?? ''}
              onChange={(automationId) => onChange({ automationId: automationId || undefined })}
            />
          </div>
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={qr.isHidden} onChange={(e) => onChange({ isHidden: e.target.checked })} />
            {t('不在按钮条里显示（只用来自动执行或被 /qr 调用）')}
          </label>
          <div>
            <p className="mb-1.5 text-[13px] font-medium">{t('自动执行')}</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {quickReplyEvents.map((event) => (
                <label key={event} className="flex items-center gap-1.5 text-[13px]">
                  <input
                    type="checkbox"
                    checked={qr.autoExecute[event]}
                    onChange={(e) => onChange({ autoExecute: { ...qr.autoExecute, [event]: e.target.checked } })}
                  />
                  {EVENT_LABELS()[event]}
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
