import type { Beat, ChoiceOption, MessageStage, StageOp, StagePosition } from '@nobot/shared'
import { parseCues, parseLineDelivery } from './delivery'
import type { DisplayOptions, ParseOptions, ParseResult } from './index'
import { nameSet, type Speech, scanTags, shorthand, type Tag } from './scan'
import { mvuCalls, VariableUpdates } from './vars'

const directives = new Set([
  'scene',
  'show',
  'hide',
  'expr',
  'say',
  'state',
  'choices',
  'cg',
  'sfx',
  'updatevariable',
  'combat',
  'bgm',
])
const blocks = new Set(['say', 'state', 'choices', 'updatevariable'])

/** 按文中顺序分派文本与指令，两个视图共享边界判定。 */
function walk(source: string, text: (value: string) => void, directive: (tag: Tag, body: string) => void): void {
  const tags = scanTags(source)
  let cursor = 0
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i]!
    if (!directives.has(tag.name)) continue
    text(source.slice(cursor, tag.start))
    let end = tag.end
    let body = ''
    if (!tag.closing && !tag.self) {
      if (tag.close !== undefined) {
        const close = tags[tag.close]!
        body = source.slice(tag.end, close.start)
        end = close.end
        i = tag.close
      } else if (blocks.has(tag.name)) {
        body = source.slice(tag.end)
        end = source.length
        i = tags.length
      }
    }
    if (!tag.closing) directive(tag, body)
    cursor = end
  }
  text(source.slice(cursor))
}

/** MVU 行整体隐藏，保留其余行的原始空白和 Markdown。 */
function withoutMvu(source: string, updates?: VariableUpdates): string {
  const calls = mvuCalls(source)
  if (!calls.length) return source
  const pieces: string[] = []
  let cursor = 0
  let lineStart = 0
  let scan = 0
  let hiddenUntil = 0
  for (const call of calls) {
    if (updates) {
      if (call.method === 'set') updates.set(call.path, call.value)
      else updates.add(call.path, call.value as number)
    }
    if (call.start < hiddenUntil) continue
    while (scan < call.start) {
      if (source[scan] === '\n') lineStart = scan + 1
      scan++
    }
    const newline = source.indexOf('\n', call.end)
    const end = newline < 0 ? source.length : newline
    pieces.push(source.slice(cursor, lineStart))
    cursor = end
    hiddenUntil = end
    scan = end
  }
  pieces.push(source.slice(cursor))
  return pieces.join('')
}

function updateMvu(body: string, updates: VariableUpdates): void {
  for (const call of mvuCalls(body, true)) {
    if (call.method === 'set') updates.set(call.path, call.value)
    else updates.add(call.path, call.value as number)
  }
}

function choices(body: string): ChoiceOption[] {
  const options: ChoiceOption[] = []
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*(?:[-*•]|\d+[.、．)）])\s*(.+)$/.exec(line)
    if (!match) continue
    let text = match[1]!.trim()
    const check = /^(?:\[([^\]]+)\]|【([^】]+)】)\s*/.exec(text)
    const prefix = (check?.[1] ?? check?.[2] ?? '').trim()
    const dcAt = prefix.toLowerCase().lastIndexOf('dc')
    const skill = prefix.slice(0, dcAt).trim()
    const dc = prefix.slice(dcAt + 2).trim()
    if (check && dcAt > 0 && /\s/.test(prefix[dcAt - 1]!) && skill && /^\d+$/.test(dc)) {
      text = text.slice(check[0].length)
      options.push({ text, check: { skill, dc: Number(dc) } })
    } else options.push({ text })
  }
  return options
}

function position(value: string | undefined): StagePosition | undefined {
  const normalized = value?.toLowerCase()
  if (normalized === 'left' || normalized === 'center' || normalized === 'right') return normalized
  if (normalized && /^[1-5]$/.test(normalized)) return Number(normalized) as StagePosition
  return undefined
}

function stageOperation(tag: Tag): StageOp | undefined {
  const a = tag.attrs
  const bgm = (value: string) => (/^(none|stop|off)?$/i.test(value.trim()) ? '' : value)
  if (tag.name === 'bgm') return { op: 'scene', bgm: bgm(a.name ?? '') }
  if (tag.name === 'scene') {
    const op: StageOp = { op: 'scene' }
    for (const key of ['bg', 'bgm', 'place', 'time'] as const) if (a[key] !== undefined) op[key] = a[key]
    if (op.bgm !== undefined) op.bgm = bgm(op.bgm)
    return op
  }
  if (tag.name === 'combat') {
    const command = /^\s*(start|next|end)\b\s*[:：]?\s*(.*?)\s*\/?$/i.exec(tag.raw ?? '')
    const action = (a.action ?? command?.[1])?.toLowerCase()
    if (action === 'next' || action === 'end') return { op: 'combat', action }
    if (action === 'start') {
      const who = (a.who ?? command?.[2] ?? '')
        .split(/[,，]/)
        .map((name) => name.trim())
        .filter(Boolean)
      return { op: 'combat', action, who }
    }
    return
  }
  if (!a.who?.trim()) return
  const who = a.who.trim()
  if (tag.name === 'hide') return { op: 'hide', who }
  if (tag.name === 'expr') {
    const expression = a.v ?? a.expr
    if (expression !== undefined) return { op: 'expr', who, expression }
  }
  if (tag.name === 'show') {
    const op: StageOp = { op: 'show', who }
    const at = position(a.at)
    if (at !== undefined) op.at = at
    if (a.outfit !== undefined) op.outfit = a.outfit
    if (a.expr !== undefined) op.expression = a.expr
    return op
  }
}

export function parseStageMessage(content: string, opts: ParseOptions): ParseResult {
  const stage: MessageStage = { v: 1, beats: [], ops: [] }
  const warnings: string[] = []
  const updates = new VariableUpdates(opts.vars)
  const known = nameSet(opts.knownNames)
  const narrators = nameSet(opts.narratorNames ?? [])
  const expressions = opts.expressions ? new Set(opts.expressions) : undefined
  const limit = Number.isFinite(opts.narrationSplit) ? Math.max(1, Math.floor(opts.narrationSplit!)) : 120
  const warnExpression = (expression: string | undefined): void => {
    if (expression !== undefined && expressions && !expressions.has(expression))
      warnings.push(`未知表情：${expression}`)
  }
  const operation = (op: StageOp, beat = true): void => {
    stage.ops.push(op)
    if ('expression' in op) warnExpression(op.expression)
    if (!beat) return
    const last = stage.beats.at(-1)
    if (last?.kind === 'stage') last.ops.push(op)
    else stage.beats.push({ kind: 'stage', ops: [op] })
  }
  const narration = (text: string): void => {
    const chars = Array.from(text)
    let start = 0
    while (start < chars.length) {
      let end = Math.min(chars.length, start + limit)
      if (end < chars.length) {
        for (let i = end - 1; i >= start; i--) {
          if ('。！？…!?'.includes(chars[i]!)) {
            end = i + 1
            break
          }
        }
      }
      stage.beats.push({ kind: 'narration', text: chars.slice(start, end).join('') })
      start = end
    }
  }
  const speech = (line: Speech): void => {
    if (line.narrator) {
      for (const part of line.text.split(/\r?\n/)) if (part.trim()) narration(part.trim())
      return
    }
    operation(
      line.expression !== undefined
        ? { op: 'expr', who: line.speaker, expression: line.expression }
        : { op: 'show', who: line.speaker },
      false,
    )
    const beat: Beat = { kind: 'line', speaker: line.speaker, text: line.text }
    if (line.expression !== undefined) beat.expression = line.expression
    if (line.tone !== undefined) beat.delivery = parseLineDelivery(line.tone)
    const cues = parseCues(line.text).cues
    if (cues.length) beat.cues = cues
    stage.beats.push(beat)
  }
  walk(
    content,
    (raw) => {
      const visible = withoutMvu(raw, opts.mvu ? updates : undefined)
      for (const line of visible.split(/\r?\n/)) {
        if (!line.trim()) continue
        const parsed = shorthand(line, known, narrators)
        if (parsed) speech(parsed)
        else narration(line.trim())
      }
    },
    (tag, body) => {
      const op = stageOperation(tag)
      if (op) operation(op)
      else if (tag.name === 'say' && tag.attrs.who?.trim()) {
        const speaker = tag.attrs.who.trim()
        speech({
          speaker,
          text: body,
          tone: tag.attrs.tone,
          ...(tag.attrs.expr !== undefined ? { expression: tag.attrs.expr } : {}),
          narrator: narrators.has(speaker.toLowerCase()),
        })
      } else if (tag.name === 'state' && opts.inline) updates.inline(body, warnings)
      else if (tag.name === 'updatevariable' && opts.mvu) updateMvu(body, updates)
      else if (tag.name === 'choices') {
        const options = choices(body)
        stage.choices = options
        stage.beats.push({ kind: 'choices', options })
      } else if (tag.name === 'cg') stage.beats.push({ kind: 'cg', prompt: tag.attrs.prompt ?? '' })
      else if (tag.name === 'sfx') stage.beats.push({ kind: 'sfx', name: tag.attrs.name ?? '' })
      else if (['show', 'hide', 'expr', 'say'].includes(tag.name)) warnings.push(`舞台标签缺少必要属性：${tag.name}`)
    },
  )
  if (warnings.length) stage.warnings = warnings
  return { stage, varsPatch: Object.keys(updates.patch).length ? updates.patch : null }
}

export function toDisplayText(content: string, opts: DisplayOptions): string {
  if (opts.streaming) {
    const last = content.lastIndexOf('<')
    if (last > content.lastIndexOf('>')) content = content.slice(0, last)
  }
  const known = nameSet(opts.knownNames)
  const narrators = nameSet(opts.narratorNames ?? [])
  const parts: string[] = []
  const speech = (line: Speech): string => {
    if (line.narrator || opts.speaker === 'none') return line.text
    return `${opts.speaker === 'bold' ? `**${line.speaker}**` : line.speaker}：${line.text}`
  }
  walk(
    content,
    (raw) => {
      parts.push(
        withoutMvu(raw)
          .split('\n')
          .map((line) => {
            const parsed = shorthand(line, known, narrators)
            return parsed ? speech(parsed) : line
          })
          .join('\n'),
      )
    },
    (tag, body) => {
      if (tag.name === 'say') {
        const speaker = tag.attrs.who?.trim() ?? ''
        parts.push(speech({ speaker, text: body, narrator: narrators.has(speaker.toLowerCase()) }))
      }
    },
  )
  return parseCues(parts.join(''))
    .text.replace(/\r\n/g, '\n')
    .replace(/\n[\t ]*\n(?:[\t ]*\n)+/g, '\n\n')
    .trim()
}
