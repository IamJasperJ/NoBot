import { type LorebookDTO, type LorebookEntryDTO, lorebookEntryDataSchema, lorebookInput } from '@nobot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { keys } from '../../api/queries'
import { SwitchField, TextAreaField, TextField, Toggle } from '../../components/form'
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon } from '../../components/icons'
import { DetailHeader } from '../../components/layout'
import { Button, controlClass, cx, Field, IconButton } from '../../components/ui'
import { t } from '../../i18n'
import { wiPositionLabels } from '../../i18n-labels'
import { errorMessage, toast } from '../../stores/toast'
import { EntryEditor } from './EntryEditor'
import { isDifferent, type LeaveGuard, SaveActions, useLeaveGuard } from './editor'

const metadata = (book: LorebookDTO) => ({ name: book.name, description: book.description, isGlobal: book.isGlobal })

export function BookEditor({
  book,
  entries,
  guard,
  onBack,
  onDeleted,
}: {
  book: LorebookDTO
  entries: LorebookEntryDTO[]
  guard: LeaveGuard
  onBack: () => void
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const [base, setBase] = useState(() => metadata(book))
  const [draft, setDraft] = useState(() => metadata(book))
  const [entryBase, setEntryBase] = useState<LorebookEntryDTO | null>(null)
  const [entryDraft, setEntryDraft] = useState<LorebookEntryDTO | null>(null)
  const [search, setSearch] = useState('')
  const [pending, setPending] = useState(false)
  const dirty = isDifferent(base, draft)
  const entryDirty = isDifferent(entryBase, entryDraft)
  useLeaveGuard(guard, dirty || entryDirty, pending)
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: keys.lorebooks }),
      qc.invalidateQueries({ queryKey: keys.lorebook(book.id) }),
    ])
  const run = async (action: () => Promise<void>) => {
    if (pending) return
    setPending(true)
    try {
      await action()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setPending(false)
    }
  }
  const openEntry = (entry: LorebookEntryDTO | null) => {
    if (pending || (entryDirty && !confirm(t('条目有未保存的修改，确定放弃这些修改吗？')))) return
    setEntryBase(entry)
    setEntryDraft(entry ? structuredClone(entry) : null)
  }
  const saveBook = () => {
    const parsed = lorebookInput.safeParse(draft)
    if (!parsed.success) {
      toast.error(t('世界书名字不能为空'))
      return
    }
    void run(async () => {
      const saved = metadata(await api.updateLorebook(book.id, parsed.data))
      setBase(saved)
      setDraft(saved)
      await refresh()
      toast.info(t('世界书已保存'))
    })
  }
  const saveEntry = () => {
    if (!entryDraft) return
    const parsed = lorebookEntryDataSchema.safeParse(entryDraft)
    if (!parsed.success) {
      toast.error(t('请检查条目设置：数字必须为规定范围内的整数'))
      return
    }
    void run(async () => {
      const saved = await api.updateEntry(entryDraft.id, parsed.data)
      setEntryBase(saved)
      setEntryDraft(structuredClone(saved))
      await refresh()
      toast.info(t('条目已保存'))
    })
  }
  const removeEntry = () => {
    if (
      !entryDraft ||
      !confirm(
        t('确定删除条目「{name}」及其内容吗？此操作无法撤销。', {
          name: entryDraft.comment || entryDraft.keys[0] || t('未命名条目'),
        }),
      )
    )
      return
    void run(async () => {
      await api.deleteEntry(entryDraft.id)
      setEntryBase(null)
      setEntryDraft(null)
      await refresh()
    })
  }
  const toggleEnabled = (entry: LorebookEntryDTO, enabled: boolean) =>
    void run(async () => {
      await api.updateEntry(entry.id, { enabled })
      // 即时开关只同步 enabled，保留正在编辑的其他字段。
      if (entryBase?.id === entry.id) {
        setEntryBase((current) => (current ? { ...current, enabled } : current))
        setEntryDraft((current) => (current ? { ...current, enabled } : current))
      }
      await refresh()
    })
  const move = (index: number, offset: number) =>
    void run(async () => {
      const ids = entries.map((entry) => entry.id)
      const next = index + offset
      const id = ids[index]
      const other = ids[next]
      if (!id || !other) return
      ids[index] = other
      ids[next] = id
      await api.reorderEntries(book.id, ids)
      await refresh()
    })
  const needle = search.trim().toLocaleLowerCase()
  const visible = entries
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        entry.id === entryDraft?.id ||
        [entry.comment, ...entry.keys, ...entry.secondaryKeys, entry.content].some((text) =>
          text.toLocaleLowerCase().includes(needle),
        ),
    )
  return (
    <>
      <DetailHeader
        title={base.name}
        onBack={onBack}
        actions={<SaveActions dirty={dirty} pending={pending} save={saveBook} reset={() => setDraft({ ...base })} />}
      />
      <fieldset disabled={pending} className="mx-auto min-w-0 max-w-5xl space-y-5 p-4">
        <div className="space-y-4">
          <TextField
            label={t('世界书名字')}
            hint={t('在世界书列表和角色关联设置中显示的名字。')}
            value={draft.name}
            onChange={(name) => setDraft((d) => ({ ...d, name }))}
          />
          <TextAreaField
            label={t('描述')}
            hint={t('记录这本世界书的主题与用途，方便整理。')}
            rows={2}
            value={draft.description}
            onChange={(description) => setDraft((d) => ({ ...d, description }))}
          />
          <SwitchField
            label={t('全局')}
            hint={t('开启后所有会话都会使用这本世界书')}
            checked={draft.isGlobal}
            onChange={(isGlobal) => setDraft((d) => ({ ...d, isGlobal }))}
          />
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" onClick={() => api.exportLorebook(book.id)}>
              <DownloadIcon />
              {t('导出')}
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                if (
                  !confirm(
                    t(
                      '确定删除世界书「{name}」及其全部 {count} 个条目吗？角色和会话对这本书的关联也会移除，此操作无法撤销。',
                      { name: base.name, count: entries.length },
                    ),
                  )
                )
                  return
                void run(async () => {
                  await api.deleteLorebook(book.id)
                  await refresh()
                  onDeleted()
                })
              }}
            >
              {t('删除世界书')}
            </Button>
          </div>
        </div>
        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <Field label={t('搜索条目')} hint={t('按备注、关键词或内容过滤；正在编辑的条目会保留显示。')}>
              <input
                type="search"
                className={controlClass}
                value={search}
                placeholder={t('输入搜索词')}
                onChange={(e) => setSearch(e.target.value)}
              />
            </Field>
          </div>
          <Button
            disabled={pending}
            onClick={() => {
              if (entryDirty && !confirm(t('条目有未保存的修改，确定放弃并添加新条目吗？'))) return
              void run(async () => {
                const entry = await api.createEntry(book.id, { comment: t('新条目') })
                setEntryBase(entry)
                setEntryDraft(structuredClone(entry))
                setSearch('')
                await refresh()
              })
            }}
          >
            {t('添加条目')}
          </Button>
        </div>
        <p className="text-xs text-zinc-500">
          {t('共 {total} 个条目，当前显示 {visible} 个。上移/下移调整列表顺序，插入顺序由各条目的数字单独控制。', {
            total: entries.length,
            visible: visible.length,
          })}
        </p>
        {entries.length === 0 ? (
          <p className="py-8 text-center text-sm text-zinc-500">
            {t('还没有条目，点击「添加条目」开始编写世界设定。')}
          </p>
        ) : (
          visible.length === 0 && (
            <p className="py-8 text-center text-sm text-zinc-500">{t('没有匹配的条目，请更换搜索词。')}</p>
          )
        )}
        <div className="space-y-2">
          {visible.map(({ entry, index }) => {
            const expanded = entryDraft?.id === entry.id
            return (
              <article key={entry.id} className="min-w-0 rounded-xl border border-zinc-200 dark:border-zinc-800">
                <div className="overflow-x-auto">
                  <div className="flex h-11 min-w-[21rem] items-center gap-2 px-2">
                    <Toggle
                      label={t('启用{name}', { name: entry.comment || entry.keys[0] || t('未命名条目') })}
                      checked={entry.enabled}
                      disabled={pending}
                      onChange={(v) => toggleEnabled(entry, v)}
                    />
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={`entry-${entry.id}`}
                      title={entry.comment || entry.keys[0] || t('未命名条目')}
                      className="min-w-[8em] flex-1 truncate text-left text-sm font-medium"
                      onClick={() => openEntry(expanded ? null : entry)}
                    >
                      {entry.comment || entry.keys[0] || t('未命名条目')}
                    </button>
                    <span
                      title={t('{keywords} · {position} · 顺序 {order}', {
                        keywords: entry.keys.slice(0, 3).join('、') || t('无关键词'),
                        position: wiPositionLabels()[entry.position],
                        order: entry.order,
                      })}
                      className={cx(
                        'shrink-0 rounded px-1.5 py-0.5 text-xs',
                        entry.constant
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                          : 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
                      )}
                    >
                      {entry.constant ? t('常驻') : t('关键词')}
                    </span>
                    <div className="flex shrink-0">
                      <IconButton label={t('上移')} disabled={pending || index === 0} onClick={() => move(index, -1)}>
                        <ChevronLeftIcon className="rotate-90" />
                      </IconButton>
                      <IconButton
                        label={t('下移')}
                        disabled={pending || index === entries.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ChevronRightIcon className="rotate-90" />
                      </IconButton>
                    </div>
                  </div>
                </div>
                {expanded && (
                  <div id={`entry-${entry.id}`}>
                    <EntryEditor
                      key={entry.id}
                      draft={entryDraft}
                      onChange={(data) => setEntryDraft({ ...entryDraft, ...data })}
                      dirty={entryDirty}
                      pending={pending}
                      save={saveEntry}
                      reset={() => setEntryDraft(entryBase ? structuredClone(entryBase) : null)}
                      remove={removeEntry}
                    />
                  </div>
                )}
              </article>
            )
          })}
        </div>
      </fieldset>
    </>
  )
}
