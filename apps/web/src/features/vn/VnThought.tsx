import type { PlayPresetData } from '@nobot/shared'
import { useEffect, useRef, useState } from 'react'
import { cx } from '../../components/ui'
import { t } from '../../i18n'

/**
 * 演出时显示到第几段：跟着演出进度按比例浮现，至少一段；生成中和演完时全部显示。
 * index 是当前停留拍的下标（0 起），count 是这条消息一共停留几拍
 */
export function thoughtVisibleCount(paragraphs: number, index: number, count: number, full: boolean) {
  if (full || count <= 0) return paragraphs
  return Math.min(paragraphs, Math.max(1, Math.ceil((paragraphs * (index + 1)) / count)))
}

/**
 * VN 思考气泡：把模型的思考内容画成一朵云，挂在画面左上方（对话框之上，不挡立绘中间）。
 * - 「只在生成时显示」：只在这条回复生成中显示实时思考，生成完就消失
 * - 「一直保留」：生成中实时显示；演出时随进度分段浮现；演完显示全部
 * 点标题可以收起成一枚小胶囊（这次打开的页面里一直有效）
 */
export function VnThought({
  mode,
  reasoning,
  index,
  count,
  ended,
  top,
}: {
  mode: PlayPresetData['dialog']['reasoning']
  reasoning: { text: string; live: boolean } | null
  index: number
  count: number
  ended: boolean
  /** 顶部操作栏和状态栏的高度（px），气泡贴在它下面 */
  top: number
}) {
  const [collapsed, setCollapsed] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const visible = mode !== 'off' && !!reasoning?.text.trim() && (mode === 'always' || reasoning.live)
  const paragraphs = visible
    ? (reasoning?.text ?? '')
        .split(/\n+/)
        .map((p) => p.trim())
        .filter(Boolean)
    : []
  const shown = paragraphs.slice(0, thoughtVisibleCount(paragraphs.length, index, count, !!reasoning?.live || ended))
  const total = shown.join('\n').length

  // 新内容出现时滚到最下面（实时思考一直往下写）
  useEffect(() => {
    if (total && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [total])

  if (!visible || !shown.length) return null
  const offset = { top: top + 8 }
  const title = reasoning?.live ? t('正在思考…') : t('思考')

  if (collapsed)
    return (
      <button
        type="button"
        className="vn-thought pointer-events-auto absolute left-3 rounded-full px-3 py-1 text-xs md:left-6"
        style={offset}
        onClick={() => setCollapsed(false)}
        title={t('展开思考内容')}
      >
        💭 {title}
      </button>
    )

  return (
    <div
      className="pointer-events-auto absolute left-3 w-[min(24rem,calc(100%-1.5rem))] md:left-6"
      // 推进剧情的按钮在最底层、和叠加层是兄弟元素，气泡里滚动、点击不会推进
      style={offset}
    >
      <div className="vn-thought rounded-[1.75rem] px-4 pt-2 pb-3">
        <button
          type="button"
          className="mb-1 flex w-full items-center gap-1.5 text-left text-xs font-semibold opacity-70 hover:opacity-100"
          onClick={() => setCollapsed(true)}
          title={t('收起思考内容')}
        >
          💭 {title}
          {reasoning?.live && <span className="ml-0.5 inline-block size-1.5 animate-pulse rounded-full bg-current" />}
        </button>
        <div ref={scroller} className="max-h-[30vh] space-y-1.5 overflow-y-auto text-[13px] leading-relaxed italic">
          {shown.map((p, i) => (
            // 段落只会在末尾追加，下标做 key：已显示的段落不会重播淡入
            <p key={i} className={cx('whitespace-pre-wrap', !reasoning?.live && 'vn-thought-in')}>
              {p}
            </p>
          ))}
        </div>
      </div>
      {/* 云朵的小尾巴：指向下方的立绘 */}
      <span aria-hidden="true" className="vn-thought-dot absolute -bottom-3 left-10 block size-3.5 rounded-full" />
      <span aria-hidden="true" className="vn-thought-dot absolute -bottom-6 left-7 block size-2 rounded-full" />
    </div>
  )
}
