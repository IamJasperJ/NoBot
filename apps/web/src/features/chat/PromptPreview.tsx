import type { PromptSegment } from '@ai-parter/shared'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import { RefreshIcon, XIcon } from '../../components/icons'
import { IconButton } from '../../components/ui'
import { errorMessage } from '../../stores/toast'
import { useUi } from '../../stores/ui'

/** 每种来源的中文名和颜色，方便一眼看出 Prompt 由哪些部分组成 */
const SOURCES: Record<string, { label: string; color: string }> = {
  main: { label: '主系统提示', color: 'border-violet-500' },
  char_description: { label: '角色描述', color: 'border-sky-500' },
  char_personality: { label: '角色性格', color: 'border-sky-500' },
  scenario: { label: '场景', color: 'border-sky-500' },
  persona: { label: '用户人设', color: 'border-emerald-500' },
  examples: { label: '示例对话', color: 'border-amber-500' },
  history: { label: '历史消息', color: 'border-zinc-400' },
  author_note: { label: '作者注释', color: 'border-pink-500' },
  post_history: { label: '历史后指令', color: 'border-violet-500' },
}

function Segment({ s }: { s: PromptSegment }) {
  const meta = SOURCES[s.source] ?? { label: s.source, color: 'border-zinc-400' }
  return (
    <div className={`border-l-4 ${meta.color} rounded-r-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-900`}>
      <div className="mb-1 flex items-center gap-2 text-xs text-zinc-500">
        <span className="font-medium">{meta.label}</span>
        <span>{s.role}</span>
        <span className="ml-auto tabular-nums">{s.tokens} token</span>
      </div>
      <div className="line-clamp-6 text-sm whitespace-pre-wrap">{s.content}</div>
    </div>
  )
}

/** 右侧面板：显示下一次生成会发给模型的完整 Prompt */
export function PromptPreview({ chatId }: { chatId: string }) {
  const setPreviewOpen = useUi((s) => s.setPreviewOpen)
  const preview = useQuery({
    queryKey: ['preview', chatId],
    queryFn: () => api.promptPreview(chatId),
    // 每次打开面板都重新组装
    gcTime: 0,
  })
  const report = preview.data?.report

  return (
    <aside className="fixed inset-0 z-30 flex flex-col bg-white lg:static lg:w-96 lg:border-l lg:border-zinc-200 dark:bg-zinc-950 lg:dark:border-zinc-800">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800">
        <div className="flex-1 font-semibold">Prompt 预览</div>
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
              {report.historyKept} / {report.historyTotal} 条
            </div>
            {report.segments.map((s, i) => (
              <Segment key={i} s={s} />
            ))}
          </>
        )}
      </div>
    </aside>
  )
}
