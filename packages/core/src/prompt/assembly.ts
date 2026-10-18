import type { ChatMessage, PresetBehavior, PromptSegment } from '@ai-parter/shared'

/** 来源信息跟随片段移动，避免预览顺序与发送顺序分离。 */
export interface Piece {
  message: ChatMessage
  source: string
  label: string
  labelCode?: string
  labelParams?: Record<string, string>
  messageId?: string
  depth?: number
  example?: boolean
  protected?: boolean
  /** 即使图片已退化成占位文字，仍保留原消息边界。 */
  imageBoundary?: boolean
}

export interface Injection {
  piece: Piece
  depth: number
  order: number
}

/** 先识别原始前缀，再替换正文宏，以免角色名里的冒号破坏解析。 */
export function parseExample(
  text: string,
  user: string,
  char: string,
  members: string[],
): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const result: { role: 'system' | 'user' | 'assistant'; content: string }[] = []
  const prefixes = [
    { name: '{{user}}', role: 'user' as const, macro: true },
    { name: '{{char}}', role: 'assistant' as const, macro: true },
    { name: user, role: 'user' as const, macro: false },
    ...[char, ...members].map((name) => ({ name, role: 'assistant' as const, macro: false })),
  ].sort((a, b) => b.name.length - a.name.length)
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart()
    const prefix = prefixes.find(({ name, macro }) => {
      const start = trimmed.slice(0, name.length)
      return (
        name.length > 0 &&
        (macro ? start.toLowerCase() === name : start === name) &&
        /^\s*[:：]/.test(trimmed.slice(name.length))
      )
    })
    if (prefix) {
      result.push({ role: prefix.role, content: trimmed.slice(prefix.name.length).replace(/^\s*[:：]\s*/, '') })
    } else {
      const previous = result.at(-1)
      if (previous) previous.content += `\n${line}`
      else if (line.trim()) result.push({ role: 'system', content: line })
    }
  }
  return result
}

/** 相同深度、顺序和角色才共用一条消息；稳定排序保留同优先级条目的来源顺序。 */
export function groupInjections(injections: Injection[]): Injection[] {
  const rank = { user: 0, assistant: 1, system: 2, tool: 3 }
  const sorted = [...injections].sort(
    (a, b) => b.depth - a.depth || a.order - b.order || rank[a.piece.message.role] - rank[b.piece.message.role],
  )
  const result: Injection[] = []
  for (const injection of sorted) {
    const previous = result.at(-1)
    if (
      previous &&
      previous.depth === injection.depth &&
      previous.order === injection.order &&
      previous.piece.message.role === injection.piece.message.role
    ) {
      previous.piece.message.content += `\n${injection.piece.message.content}`
      previous.piece.label += `、${injection.piece.label}`
    } else {
      result.push({ ...injection, piece: { ...injection.piece, message: { ...injection.piece.message } } })
    }
  }
  return result
}

export function injectHistory(history: Piece[], injections: Injection[]): Piece[] {
  const result: Piece[] = []
  for (let i = 0; i <= history.length; i++) {
    for (const injection of injections) {
      let position = Math.max(0, history.length - injection.depth)
      // 深度落在工具结果中间时前移到调用前，协议要求结果紧随调用。
      while (position > 0 && history[position]?.message.role === 'tool') position--
      if (position === i) result.push(injection.piece)
    }
    if (i < history.length) result.push(history[i]!)
  }
  return result
}

/** 名字只作用于历史和示例，提示词与深度注入不冒充发言人。 */
export function applyName(message: ChatMessage, name: string, behavior: PresetBehavior, group: boolean): ChatMessage {
  if (message.role !== 'user' && message.role !== 'assistant') return message
  const mode = behavior.namesBehavior
  if (mode === 'none' || (mode === 'default' && !group)) return message
  if (mode === 'completion') {
    const cleaned = name.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
    if (cleaned) return { ...message, name: cleaned }
  }
  return { ...message, content: `${name}: ${message.content}` }
}

/** 工具单元在整个后处理过程中保持边界，避免调用与结果被相邻消息吞并。 */
export function postprocess(pieces: Piece[], behavior: PresetBehavior): ChatMessage[] {
  let work = pieces.map((piece) => ({ ...piece, message: { ...piece.message } }))
  const merge = (squashOnly: boolean) => {
    const result: Piece[] = []
    for (const piece of work) {
      const previous = result.at(-1)
      if (
        previous &&
        !previous.protected &&
        !piece.protected &&
        previous.message.role === piece.message.role &&
        (!squashOnly || (piece.message.role === 'system' && !piece.example && !previous.example))
      ) {
        previous.message.content += `\n\n${piece.message.content}`
      } else result.push(piece)
    }
    work = result
  }
  if (behavior.squashSystem) merge(true)
  const mode = behavior.postProcessing
  if (mode === 'single_user') {
    const result: ChatMessage[] = []
    let previousImage = false
    for (const piece of work) {
      const previous = result.at(-1)
      if (piece.imageBoundary) result.push(piece.message)
      else if (previous && !previousImage) previous.content += `\n\n${piece.message.content}`
      else result.push({ role: 'user', content: piece.message.content })
      previousImage = Boolean(piece.imageBoundary)
    }
    return result
  }
  if (mode === 'semi_strict' || mode === 'strict') {
    let started = false
    for (const piece of work) {
      if (piece.message.role !== 'system') started = true
      else if (started) piece.message.role = 'user'
    }
    if (mode === 'strict') {
      const first = work.findIndex((piece) => piece.message.role !== 'system')
      if (first >= 0 && work[first]!.message.role !== 'user') {
        work.splice(first, 0, { source: 'start', label: '开始提示', message: { role: 'user', content: '[Start]' } })
      }
    }
  }
  if (mode !== 'none') merge(false)
  return work.map((piece) => piece.message)
}

export function segmentOf(piece: Piece, tokens: number): PromptSegment {
  return {
    source: piece.source,
    label: piece.label,
    ...(piece.labelCode === undefined ? {} : { labelCode: piece.labelCode }),
    ...(piece.labelParams === undefined ? {} : { labelParams: piece.labelParams }),
    role: piece.message.role,
    content: piece.message.content,
    tokens,
    ...(piece.messageId === undefined ? {} : { messageId: piece.messageId }),
    ...(piece.depth === undefined ? {} : { depth: piece.depth }),
  }
}
