import { GENERATION_TYPE_LABELS, type GenerationType, type PromptSegment } from '@ai-parter/shared'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { RefreshIcon, XIcon } from '../../components/icons'
import { cx, IconButton, inputClass } from '../../components/ui'
import { errorMessage } from '../../stores/toast'
import { useUi } from '../../stores/ui'

/** 按来源给片段上色，方便一眼看出 Prompt 由哪些部分组成 */
function colorOf(source: string) {
  if (source === 'history') return 'border-zinc-400'
  if (source === 'world_info' || source.startsWith('wi_')) return 'border-emerald-500'
  if (source.startsWith('char_') || source === 'scenario' || source === 'character_note') return 'border-sky-500'
  if (source === 'persona') return 'border-teal-500'
  if (source === 'examples') return 'border-amber-500'
  if (source === 'author_note' || source === 'nudge' || source === 'prefill') return 'border-pink-500'
  return 'border-violet-500'
}

function Segment({ s }: { s: PromptSegment }) {
  const [open, setOpen] = useState(false)
  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      className={cx(
        'block w-full rounded-r-lg border-l-4 bg-zinc-50 px-3 py-2 text-left dark:bg-zinc-900',
        colorOf(s.source),
      )}
    >
      <div className="mb-1 flex items-center gap-2 text-xs text-zinc-500">
        <span className="font-medium">{s.label}</span>
        <span>{s.role}</span>
        {s.depth !== undefined && <span>深度 {s.depth}</span>}
        <span className="ml-auto tabular-nums">{s.tokens} token</span>
      </div>
      <div className={cx('text-sm whitespace-pre-wrap', !open && 'line-clamp-4')}>{s.content}</div>
    </button>
  )
}

const TYPES: GenerationType[] = ['normal', 'continue', 'impersonate', 'regenerate']

/** 右侧面板：显示下一次生成会发给模型的完整 Prompt */
export function PromptPreview({ chatId }: { chatId: string }) {
  const setPreviewOpen = useUi((s) => s.setPreviewOpen)
  const [type, setType] = useState<GenerationType>('normal')
  const preview = useQuery({
    queryKey: ['preview', chatId, type],
    queryFn: () => api.promptPreview(chatId, { type }),
    // 每次打开面板都重新组装
    gcTime: 0,
  })
  const report = preview.data?.report
  const wi = report?.worldInfo ?? []

  return (
    <aside className="fixed inset-0 z-30 flex flex-col bg-white lg:static lg:w-96 lg:shrink-0 lg:border-l lg:border-zinc-200 dark:bg-zinc-950 lg:dark:border-zinc-800">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800">
        <div className="flex-1 font-semibold">Prompt 预览</div>
        <select
          className={cx(inputClass, 'w-auto py-1')}
          value={type}
          onChange={(e) => setType(e.target.value as GenerationType)}
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {GENERATION_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <IconButton label="刷新" onClick={() => void preview.refetch()}>
          <RefreshIcon />
        </IconButton>
        <IconButton label="关闭" onClick={() => setPreviewOpen(false)}>
          <XIcon />
        </IconButton>
      </header>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {preview.isPending && <div className="text-sm text-zinc-400">组装中…</div>}
        {preview.isError && <div className="text-sm text-red-500">{errorMessage(preview.error)}</div>}
        {report && (
          <>
            <div className="rounded-lg bg-violet-50 px-3 py-2 text-sm dark:bg-violet-950/50">
              共 <b className="tabular-nums">{report.totalTokens}</b> / {report.budget} token · 历史保留{' '}
              {report.historyKept} / {report.historyTotal} 条 · {preview.data?.messages.length} 条消息
            </div>
            {wi.length > 0 && (
              <details className="rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
                <summary className="cursor-pointer select-none">
                  世界书：插入 {wi.filter((w) => w.activated).length} / 扫描 {wi.length} 条
                </summary>
                <ul className="mt-2 space-y-1">
                  {wi.map((w) => (
                    <li key={w.entryId} className="flex gap-2">
                      <span className={w.activated ? 'text-emerald-600' : 'text-zinc-400'}>
                        {w.activated ? '✓' : '·'}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{w.comment || '（无备注）'}</span>
                      <span className="shrink-0 text-xs text-zinc-500">{w.activated ? w.reason : w.skippedReason}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {report.segments.map((s, i) => (
              <Segment key={`${s.source}-${s.messageId ?? i}`} s={s} />
            ))}
          </>
        )}
      </div>
    </aside>
  )
}
