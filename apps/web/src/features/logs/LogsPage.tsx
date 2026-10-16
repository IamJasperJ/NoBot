import type { GenerationLogSummary } from '@ai-parter/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { keys, useLog, useLogs } from '../../api/queries'
import { Section, Toggle } from '../../components/form'
import { DetailHeader, ListItem, ManagerLayout } from '../../components/layout'
import { Button, cx } from '../../components/ui'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { CollapsibleContent, isRecord, JsonBlock, ReportSection, roleLabel } from './LogContent'

const kindLabels: Record<GenerationLogSummary['kind'], string> = {
  generation: '生成',
  impersonate: '代写',
  test: '测试',
  error: '服务器错误',
}
const statusLabels: Record<GenerationLogSummary['status'], string> = { ok: '成功', error: '错误', aborted: '已中止' }
const statusColors = { ok: 'bg-green-500', error: 'bg-red-500', aborted: 'bg-zinc-400' }
const duration = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} 秒`)
const time = (createdAt: number) => new Date(createdAt).toLocaleString('zh-CN')

function LogDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const query = useLog(id)
  const log = query.data
  const request = log?.request
  const messages = isRecord(request) && Array.isArray(request.messages) ? request.messages : null
  const parameters = isRecord(request)
    ? Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'messages'))
    : request
  return (
    <>
      <DetailHeader title="日志详情" onBack={onBack} />
      <div className="space-y-4 p-4 sm:p-6">
        {query.isPending ? (
          <p>加载中…</p>
        ) : query.isError ? (
          <p role="alert" className="text-red-600">
            {errorMessage(query.error)}
          </p>
        ) : (
          log && (
            <>
              <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                {Object.entries({
                  类型: kindLabels[log.kind],
                  状态: statusLabels[log.status],
                  模型: log.model ?? '—',
                  耗时: duration(log.durationMs),
                  时间: time(log.createdAt),
                  '会话 id': log.chatId ?? '—',
                  '消息 id': log.messageId ?? '—',
                }).map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <dt className="text-zinc-500">{label}</dt>
                    <dd className="break-all">{value}</dd>
                  </div>
                ))}
              </dl>
              {log.summary && (
                <div
                  className={cx(
                    'rounded-lg p-3 whitespace-pre-wrap break-words text-sm',
                    log.status === 'error'
                      ? 'border border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300'
                      : 'bg-zinc-100 dark:bg-zinc-900',
                  )}
                >
                  {log.summary}
                </div>
              )}
              <Section title="发送的消息">
                {messages ? (
                  messages.length ? (
                    messages.map((message: unknown, index: number) => (
                      // 请求中的消息没有稳定 id，日志只读，使用原始顺序标识。
                      <div key={index} className="min-w-0 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                        <div className="mb-2 text-xs font-semibold text-violet-600">
                          {index + 1} ·{' '}
                          {isRecord(message) && typeof message.role === 'string' ? roleLabel(message.role) : '未知角色'}
                        </div>
                        {isRecord(message) && typeof message.content === 'string' ? (
                          <CollapsibleContent content={message.content} />
                        ) : (
                          <JsonBlock value={message} />
                        )}
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-zinc-500">本次请求的消息数组为空。</p>
                  )
                ) : (
                  <p className="text-sm text-zinc-500">本次请求未记录消息数组，可在请求参数中查看完整数据。</p>
                )}
              </Section>
              {log.report !== null && log.report !== undefined && <ReportSection report={log.report} />}
              <Section title="请求参数" description="仅展示消息以外的参数；复制按钮会复制包含消息的完整请求 JSON。">
                <JsonBlock value={parameters} copyValue={request} />
              </Section>
              <Section title="模型返回">
                <JsonBlock value={log.response} />
              </Section>
            </>
          )
        )}
      </div>
    </>
  )
}

export function LogsPage() {
  const query = useLogs()
  const qc = useQueryClient()
  const focusId = useUi((s) => s.focusId)
  const [selectedId, setSelectedId] = useState<string | null>(focusId)
  const [onlyErrors, setOnlyErrors] = useState(false)
  const [clearing, setClearing] = useState(false)
  useEffect(() => {
    if (focusId) setSelectedId(focusId)
  }, [focusId])
  const logs = query.data?.filter((log) => !onlyErrors || log.status === 'error') ?? []

  async function clear() {
    if (!confirm('确定清空全部请求日志吗？日志中的请求、模型返回和错误记录都会删除，无法恢复。')) return
    setClearing(true)
    try {
      await api.clearLogs()
      setSelectedId(null)
      useUi.getState().openView('logs')
      // 清除已打开的详情缓存，避免清空后仍显示旧请求。
      qc.removeQueries({ queryKey: keys.log('').slice(0, 1) })
      await qc.invalidateQueries({ queryKey: keys.logs().slice(0, 1) })
      toast.info('已清空全部日志')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setClearing(false)
    }
  }

  return (
    <ManagerLayout
      title="日志"
      actions={
        <Button variant="danger" disabled={clearing} onClick={() => void clear()}>
          {clearing ? '清空中…' : '清空'}
        </Button>
      }
      showDetailOnMobile={selectedId !== null}
      list={
        <>
          <div className="mb-3 flex items-center justify-between gap-2 px-2">
            <div className="flex items-center gap-2">
              <Toggle label="只看错误" checked={onlyErrors} onChange={setOnlyErrors} />
              <span className="whitespace-nowrap text-xs text-zinc-500">只看错误</span>
            </div>
            <Button disabled={query.isFetching} onClick={() => void query.refetch()}>
              {query.isFetching ? '刷新中…' : '刷新'}
            </Button>
          </div>
          {query.isPending ? (
            <p className="p-2 text-sm">加载中…</p>
          ) : query.isError ? (
            <p role="alert" className="p-2 text-sm text-red-600">
              {errorMessage(query.error)}
            </p>
          ) : logs.length === 0 ? (
            <p className="p-2 text-sm text-zinc-500">
              {onlyErrors
                ? '暂无错误日志，可以关闭筛选查看其他请求。'
                : '暂无日志。发送消息或测试连接后，请在这里查看请求记录。'}
            </p>
          ) : (
            logs.map((log) => (
              <ListItem key={log.id} active={selectedId === log.id} onClick={() => setSelectedId(log.id)}>
                <span
                  role="img"
                  aria-label={statusLabels[log.status]}
                  title={statusLabels[log.status]}
                  className={cx('size-2 shrink-0 rounded-full', statusColors[log.status])}
                />
                <div
                  className="flex h-8 min-w-0 flex-1 items-center gap-2"
                  title={`${kindLabels[log.kind]} · ${time(log.createdAt)} · ${log.summary || '（无摘要）'}`}
                >
                  <span className="min-w-0 flex-1 truncate">{log.model ?? '未记录模型'}</span>
                  <span className="shrink-0 text-xs text-zinc-500">{duration(log.durationMs)}</span>
                </div>
              </ListItem>
            ))
          )}
        </>
      }
      detail={selectedId ? <LogDetail key={selectedId} id={selectedId} onBack={() => setSelectedId(null)} /> : null}
    />
  )
}
