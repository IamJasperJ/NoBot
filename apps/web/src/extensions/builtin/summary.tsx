import type { SummaryEntryDTO, SummaryStateDTO } from '@ai-parter/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api as http } from '../../api/client'
import { Toggle } from '../../components/form'
import { BookIcon, ChevronRightIcon, EditIcon, RefreshIcon, TrashIcon } from '../../components/icons'
import { Button, cx, IconButton, inputClass } from '../../components/ui'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import type { ClientExtensionAPI } from '../types'

/**
 * 剧情总结扩展的前端（后端见 apps/server/src/extensions/builtin/summary）：
 * - 会话设置里的「记忆」分组：当前总结（可编辑）、立即总结、暂停自动总结、历史总结
 * - 总结挂在哪条消息上，那条消息下面显示一个「剧情总结到这里」的小标记，点了打开会话设置
 * 设置页由 settingsSchema 自动生成，这里不用管
 */
export default function activate(ext: ClientExtensionAPI) {
  ext.registerSlot('chat.settings.sections', {
    id: 'memory',
    title: '记忆（剧情总结）',
    order: 50,
    render: ({ chatId }) => <MemorySection key={chatId} chatId={chatId} ext={ext} />,
  })
  ext.registerSlot('chat.message.footer', {
    id: 'summary-mark',
    render: ({ message }) => (message.meta.summary ? <SummaryMark /> : null),
  })
}

const stateKey = (chatId: string) => ['summary-state', chatId] as const

function SummaryMark() {
  const open = () => {
    const ui = useUi.getState()
    ui.setPreviewOpen(false)
    ui.setChatSettingsOpen(true)
    ui.openView('chat')
  }
  return (
    <button
      type="button"
      onClick={open}
      title="剧情总结到这条消息为止，点击在会话设置里查看"
      className="mt-2 inline-flex items-center gap-1 rounded-md bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/50 dark:text-emerald-300 dark:hover:bg-emerald-900/60"
    >
      <BookIcon className="size-3" />
      剧情总结到这里
    </button>
  )
}

function MemorySection({ chatId, ext }: { chatId: string; ext: ClientExtensionAPI }) {
  const qc = useQueryClient()
  const state = useQuery({
    queryKey: stateKey(chatId),
    queryFn: () => http.summaryState(chatId),
    // 总结在后台跑：进行中每 2 秒看一次
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
  })
  const [busy, setBusy] = useState(false)
  // 每轮生成完可能触发了自动总结，刷新一下状态
  useEffect(
    () =>
      ext.on('generation:complete', (e) => {
        if (e.chatId === chatId) setTimeout(() => void state.refetch(), 400)
      }),
    [chatId],
  )
  // 总结完成：消息上的「总结到这里」标记要跟着变，重新拉一次会话
  const running = !!state.data?.running
  const [wasRunning, setWasRunning] = useState(running)
  if (wasRunning !== running) {
    setWasRunning(running)
    if (!running) void qc.invalidateQueries({ queryKey: ['chat', chatId] })
  }

  const act = async (fn: () => Promise<SummaryStateDTO>, done?: string) => {
    if (busy) return
    setBusy(true)
    try {
      const next = await fn()
      qc.setQueryData(stateKey(chatId), next)
      void qc.invalidateQueries({ queryKey: ['chat', chatId] })
      // 总结失败时后端不报错，而是记在 lastError 里（自动总结也是这样），这里按它提示
      if (next.lastError) toast.error(`总结失败：${next.lastError}`)
      else if (done) toast.info(done)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (state.isError) return <p className="text-xs text-red-600">{errorMessage(state.error)}</p>
  const s = state.data
  if (!s) return <p className="text-xs text-zinc-400">加载中…</p>

  return (
    <div className="space-y-3 text-[13px]">
      {/* 状态行 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-zinc-500">
          待总结 <b className="tabular-nums">{s.pending.messages}</b> 条 · 约{' '}
          <span className="tabular-nums">{s.pending.tokens}</span> token
        </span>
        {s.running && (
          <span className="inline-flex items-center gap-1 text-xs text-violet-600 dark:text-violet-400">
            <span className="size-3 animate-spin rounded-full border-2 border-violet-300 border-t-violet-600" />
            正在总结…
          </span>
        )}
        <Button
          size="sm"
          className="ml-auto"
          disabled={busy || s.running || !s.pending.messages}
          onClick={() => void act(() => http.runSummary(chatId), '已更新剧情总结')}
        >
          <RefreshIcon />
          立即总结
        </Button>
      </div>
      <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
        <Toggle
          checked={!s.frozen}
          label="这个会话自动总结"
          disabled={busy}
          onChange={(on) => void act(() => http.freezeSummary(chatId, !on))}
        />
        这个会话自动总结{s.frozen && <span className="text-zinc-400">（已暂停）</span>}
      </label>
      {s.lastError && (
        <p className="rounded-lg bg-red-50 px-2.5 py-1.5 text-xs break-words text-red-700 dark:bg-red-950/50 dark:text-red-300">
          上次总结失败：{s.lastError}
        </p>
      )}

      {s.current ? (
        <SummaryCard
          entry={s.current}
          busy={busy}
          onSave={(text) => act(() => http.editSummary(chatId, s.current!.messageId, text), '已保存总结')}
          onDelete={() => {
            if (confirm('删除这份总结？之前更早的总结会重新生效。'))
              void act(() => http.deleteSummary(chatId, s.current!.messageId))
          }}
        />
      ) : (
        <p className="text-xs text-zinc-400">当前分支还没有总结。聊到设定的条数会自动总结，也可以点「立即总结」。</p>
      )}

      {s.history.length > 0 && (
        <details className="group/history">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-zinc-500 select-none [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon className="size-3.5 transition-transform group-open/history:rotate-90" />
            更早的总结（{s.history.length}）
          </summary>
          <div className="mt-2 space-y-2">
            {s.history.map((entry) => (
              <SummaryCard
                key={entry.messageId}
                entry={entry}
                busy={busy}
                muted
                onSave={(text) => act(() => http.editSummary(chatId, entry.messageId, text), '已保存总结')}
                onDelete={() => {
                  if (confirm('删除这份旧总结？')) void act(() => http.deleteSummary(chatId, entry.messageId))
                }}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

function SummaryCard({
  entry,
  busy,
  muted,
  onSave,
  onDelete,
}: {
  entry: SummaryEntryDTO
  busy: boolean
  muted?: boolean
  onSave: (text: string) => Promise<void>
  onDelete: () => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const time = new Date(entry.createdAt).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  return (
    <div
      className={cx(
        'rounded-lg border p-2.5',
        muted
          ? 'border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/40'
          : 'border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/30',
      )}
    >
      <div className="mb-1.5 flex items-center gap-1 text-[11px] text-zinc-500">
        <span className="min-w-0 flex-1 truncate" title={entry.preview}>
          总结到：{entry.preview || '（空消息）'}
        </span>
        <span className="shrink-0 tabular-nums">
          {time} · {entry.auto ? '自动' : '手动'} · {entry.coveredCount} 条
        </span>
      </div>
      {draft === null ? (
        <div className="group/card relative">
          <p className="leading-relaxed whitespace-pre-wrap">{entry.text}</p>
          <div className="mt-1 flex justify-end gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover/card:opacity-100 md:focus-within:opacity-100">
            <IconButton label="编辑总结" disabled={busy} onClick={() => setDraft(entry.text)}>
              <EditIcon />
            </IconButton>
            <IconButton label="删除总结" variant="danger" disabled={busy} onClick={onDelete}>
              <TrashIcon />
            </IconButton>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <textarea
            aria-label="编辑总结"
            className={cx(inputClass, 'min-h-32 text-[13px]')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !draft.trim()}
              onClick={() => void onSave(draft).then(() => setDraft(null))}
            >
              保存
            </Button>
            <Button size="sm" onClick={() => setDraft(null)}>
              取消
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
