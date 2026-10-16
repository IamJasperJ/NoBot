import { memo, type ReactNode } from 'react'

/**
 * 显示时替换角色卡里常见的宏。数据库里保存的是原文（发给模型时由后端统一替换），
 * 这里只影响显示，所以换了人设之后旧消息也会显示新名字。
 * 只处理名字类的宏：{{char}} {{user}}，以及酒馆的旧写法 <BOT> <CHAR> <USER>，不区分大小写。
 */
export function displayMacros(text: string, names: { char: string; user: string }): string {
  if (!text.includes('{{') && !text.includes('<')) return text
  return text
    .replace(/\{\{\s*char\s*\}\}/gi, names.char)
    .replace(/\{\{\s*user\s*\}\}/gi, names.user)
    .replace(/<(BOT|CHAR)>/gi, names.char)
    .replace(/<USER>/gi, names.user)
}

/**
 * 角色扮演常用的轻量格式：
 *   *动作*      → 灰色斜体
 *   **强调**    → 加粗
 *   "台词" “台词” 「台词」 → 高亮
 * 不用完整的 Markdown 库：更快，而且不会有 HTML 注入的问题（全程生成 React 节点）。
 */
const TOKEN = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|"[^"\n]+"|“[^”\n]+”|「[^」\n]+」)/g

function renderInline(line: string): ReactNode[] {
  return line.split(TOKEN).map((part, i) => {
    if (i % 2 === 0) return part // 偶数位是普通文本
    if (part.startsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('*')) {
      return (
        <em key={i} className="text-zinc-500 dark:text-zinc-400">
          {part.slice(1, -1)}
        </em>
      )
    }
    return (
      <span key={i} className="text-amber-700 dark:text-amber-300">
        {part}
      </span>
    )
  })
}

/** 一个段落。用 memo 包起来：流式生成时只有最后一段在变，前面的段落不会重新渲染 */
const Paragraph = memo(function Paragraph({ text }: { text: string }) {
  return <p className="min-h-[1em] whitespace-pre-wrap break-words">{renderInline(text)}</p>
})

export function FormattedText({ text }: { text: string }) {
  const paragraphs = text.split('\n')
  return (
    <div className="message-text space-y-1.5">
      {paragraphs.map((p, i) => (
        // 段落只会在末尾增加，用下标做 key 是安全的
        <Paragraph key={i} text={p} />
      ))}
    </div>
  )
}
