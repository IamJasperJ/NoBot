import type { BuildReport, PromptSegment, WIActivation } from '@ai-parter/shared'
import { useState } from 'react'
import { Section } from '../../components/form'
import { Button, cx } from '../../components/ui'
import { errorMessage, toast } from '../../stores/toast'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function JsonBlock({ value, copyValue = value }: { value: unknown; copyValue?: unknown }) {
  const json = JSON.stringify(value, null, 2) ?? 'null'
  async function copy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(copyValue, null, 2) ?? 'null')
      toast.info('已复制')
    } catch (e) {
      toast.error(`复制失败：${errorMessage(e)}`)
    }
  }
  return (
    <div className="min-w-0 rounded-lg bg-zinc-100 p-3 dark:bg-zinc-900">
      <div className="mb-2 flex justify-end">
        <Button onClick={() => void copy()}>复制</Button>
      </div>
      <pre className="max-h-[36rem] overflow-auto font-mono text-xs">{json}</pre>
    </div>
  )
}

export function CollapsibleContent({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false)
  const collapsible = content.length > 300 || content.split(/\r\n|\r|\n/).length > 6
  return (
    <div className="min-w-0 space-y-2">
      <div
        className={cx('whitespace-pre-wrap break-words text-sm leading-6', collapsible && !expanded && 'line-clamp-6')}
      >
        {content || '（空内容）'}
      </div>
      {collapsible && (
        <Button aria-expanded={expanded} variant="ghost" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起' : '展开全文'}
        </Button>
      )}
    </div>
  )
}

const roleLabels: Record<string, string> = {
  system: '系统',
  user: '用户',
  assistant: '助手',
  tool: '工具',
  developer: '开发者',
}
export const roleLabel = (role: string) => roleLabels[role] ?? role

function isSegment(value: unknown): value is PromptSegment {
  return (
    isRecord(value) &&
    typeof value.source === 'string' &&
    typeof value.label === 'string' &&
    typeof value.role === 'string' &&
    typeof value.content === 'string' &&
    typeof value.tokens === 'number'
  )
}

function isActivation(value: unknown): value is WIActivation {
  return (
    isRecord(value) &&
    typeof value.entryId === 'string' &&
    typeof value.lorebookId === 'string' &&
    typeof value.lorebookName === 'string' &&
    typeof value.comment === 'string' &&
    typeof value.reason === 'string' &&
    typeof value.activated === 'boolean' &&
    typeof value.tokens === 'number' &&
    (value.skippedReason === undefined || typeof value.skippedReason === 'string')
  )
}

// 历史日志可能来自旧版或失败请求，校验后才使用报告字段，原始数据仍可查看。
function isBuildReport(value: unknown): value is BuildReport {
  return (
    isRecord(value) &&
    typeof value.totalTokens === 'number' &&
    typeof value.budget === 'number' &&
    typeof value.historyTotal === 'number' &&
    typeof value.historyKept === 'number' &&
    Array.isArray(value.segments) &&
    value.segments.every(isSegment) &&
    Array.isArray(value.worldInfo) &&
    value.worldInfo.every(isActivation)
  )
}

export function ReportSection({ report }: { report: unknown }) {
  return (
    <Section title="组装报告">
      {isBuildReport(report) ? (
        <>
          <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
            <div>总 token：{report.totalTokens}</div>
            <div>预算：{report.budget}</div>
            <div>
              历史保留：{report.historyKept} / {report.historyTotal} 条
            </div>
          </div>
          <div className="space-y-3">
            {report.segments.map((segment, index) => (
              // 同一来源可以生成多个片段，日志内容只读，顺序就是唯一标识。
              <div
                key={`${segment.source}-${index}`}
                className="min-w-0 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
              >
                <div className="mb-2 flex flex-wrap gap-2 text-sm font-medium">
                  <span>{segment.label}</span>
                  <span className="text-zinc-500">
                    {roleLabel(segment.role)} · {segment.tokens} token
                  </span>
                </div>
                <CollapsibleContent content={segment.content} />
              </div>
            ))}
            {report.segments.length === 0 && <p className="text-sm text-zinc-500">没有记录提示词片段。</p>}
          </div>
          <h3 className="text-sm font-semibold">世界书扫描结果</h3>
          {report.worldInfo.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-xs">
                <thead>
                  <tr>
                    {['条目备注', '所属世界书', '是否插入', '触发原因', '未插入原因', 'tokens'].map((label) => (
                      <th key={label} scope="col" className="border-b border-zinc-300 p-2 dark:border-zinc-700">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.worldInfo.map((entry, index) => (
                    <tr
                      key={`${entry.lorebookId}-${entry.entryId}-${index}`}
                      className="border-b border-zinc-200 dark:border-zinc-800"
                    >
                      <td className="p-2">{entry.comment || '（无备注）'}</td>
                      <td className="p-2">{entry.lorebookName}</td>
                      <td className="p-2">{entry.activated ? '是' : '否'}</td>
                      <td className="p-2">{entry.reason || '—'}</td>
                      <td className="p-2">{entry.skippedReason || '—'}</td>
                      <td className="p-2">{entry.tokens}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">没有世界书扫描记录。</p>
          )}
        </>
      ) : (
        <>
          <p className="text-sm text-zinc-500">报告格式与当前版本不一致，以下显示原始数据。</p>
          <JsonBlock value={report} />
        </>
      )}
    </Section>
  )
}
