import type { GenerationType, PromptSegment } from '@ai-parter/shared'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { RefreshIcon, XIcon } from '../../components/icons'
import { cx, IconButton, selectClass } from '../../components/ui'
import { t } from '../../i18n'
import { generationTypeLabels, promptSegmentLabel, wiActivationLabel } from '../../i18n-labels'
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
        <span className="font-medium">{promptSegmentLabel(s)}</span>
        <span>{s.role}</span>
        {s.depth !== undefined && <span>{t('深度 {depth}', { depth: s.depth })}</span>}
        <span className="ml-auto tabular-nums">{s.tokens} token</span>
      </div>
      {/* 折叠时裁成 4 行；用 overflow: clip 而不是 line-clamp，避免 WebKit 下滚动被这块吃掉（见日志页的说明） */}
      <div
        className={cx('text-sm leading-5 whitespace-pre-wrap', !open && 'max-h-20')}
        style={open ? undefined : { overflow: 'clip' }}
      >
        {s.content}
      </div>
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
    <aside className="flex h-full w-full flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800">
        <div className="min-w-0 flex-1 truncate font-semibold" title={t('Prompt 预览')}>
          {t('Prompt 预览')}
        </div>
        <select
          className={cx(selectClass, 'h-8 max-w-28 shrink-0')}
          value={type}
          onChange={(e) => setType(e.target.value as GenerationType)}
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {generationTypeLabels()[t]}
            </option>
          ))}
        </select>
        <IconButton label={t('刷新')} onClick={() => void preview.refetch()}>
          <RefreshIcon />
        </IconButton>
        <IconButton label={t('返回会话列表')} onClick={() => setPreviewOpen(false)}>
          <XIcon />
        </IconButton>
      </header>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {preview.isPending && <div className="text-sm text-zinc-400">{t('组装中…')}</div>}
        {preview.isError && <div className="text-sm text-red-500">{errorMessage(preview.error)}</div>}
        {report && (
          <>
            <div className="rounded-lg bg-violet-50 px-3 py-2 text-sm dark:bg-violet-950/50">
              {t('共 ')}
              <b className="tabular-nums">{report.totalTokens}</b>{' '}
              {report.excludedCount
                ? t(
                    '/ {budget} token · 历史保留 {historyKept} / {historyTotal} 条 · 已排除 {excludedCount} 条 · {messageCount} 条消息',
                    {
                      budget: report.budget,
                      historyKept: report.historyKept,
                      historyTotal: report.historyTotal,
                      excludedCount: report.excludedCount,
                      messageCount: preview.data?.messages.length ?? '',
                    },
                  )
                : t('/ {budget} token · 历史保留 {historyKept} / {historyTotal} 条 · {messageCount} 条消息', {
                    budget: report.budget,
                    historyKept: report.historyKept,
                    historyTotal: report.historyTotal,
                    messageCount: preview.data?.messages.length ?? '',
                  })}
            </div>
            {report.omittedToolCalls > 0 && (
              <div className="text-sm text-zinc-500">
                {t('省略了 {count} 条未启用工具的调用记录', { count: report.omittedToolCalls })}
              </div>
            )}
            {wi.length > 0 && (
              <details className="rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
                <summary className="cursor-pointer select-none">
                  {t('世界书：插入 {inserted} / 扫描 {scanned} 条', {
                    inserted: wi.filter((w) => w.activated).length,
                    scanned: wi.length,
                  })}
                </summary>
                <ul className="mt-2 space-y-1">
                  {wi.map((w) => (
                    <li key={w.entryId} className="flex gap-2">
                      <span className={w.activated ? 'text-emerald-600' : 'text-zinc-400'}>
                        {w.activated ? '✓' : '·'}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{w.comment || t('（无备注）')}</span>
                      <span
                        className={cx('shrink-0 text-xs', w.dropped ? 'text-amber-600' : 'text-zinc-500')}
                        title={w.lorebookName}
                      >
                        {wiActivationLabel(w)}
                      </span>
                      {w.activated && w.tokens > 0 && (
                        <span className="w-14 shrink-0 text-right text-xs text-zinc-400 tabular-nums">
                          {t('{count} token', { count: w.tokens })}
                        </span>
                      )}
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
