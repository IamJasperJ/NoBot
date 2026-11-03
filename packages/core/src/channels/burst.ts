import { hashString, seededRandom } from '../prompt/macros'

const length = (text: string) => Array.from(text).length
const meaningfulLength = (text: string) => length(text.replace(/[\s\p{P}]/gu, ''))

type Block = { text: string; whole: boolean }
/** glue 是和前一段相接时用的分隔：不同行之间用换行，同一行拆出的句子按原文直接相连。 */
type Piece = { text: string; glue: string }

const joinPieces = (pieces: Piece[]) => pieces.map((piece, index) => (index ? piece.glue : '') + piece.text).join('')

/** 保留代码、列表和引用的上下文，避免把同一结构拆到不同消息。 */
function blocks(text: string): Block[] {
  const result: Block[] = []
  let kind = ''
  let fenced = false
  for (const raw of text.trim().split(/\r?\n/)) {
    const line = raw.trim()
    if (fenced) {
      result[result.length - 1]!.text += `\n${raw}`
      if (line.startsWith('```')) fenced = false
      continue
    }
    if (line.startsWith('```')) {
      result.push({ text: raw, whole: true })
      fenced = true
      kind = ''
      continue
    }
    const nextKind = /^(?:[-*] |\d+\. |\d+、)/.test(line) ? 'list' : /^> /.test(line) ? 'quote' : ''
    if (line && nextKind && nextKind === kind) result[result.length - 1]!.text += `\n${line}`
    else if (line) result.push({ text: line, whole: !!nextKind })
    kind = nextKind
  }
  return result.map((block) => ({ ...block, text: block.text.trim() }))
}

function sentences(text: string, maxChars: number): Piece[] {
  // 数字后的点不应切开；闭合引号归属于前一句。
  const pieces =
    text.match(/.*?(?:[。！？!?…]+[」』”）)"'’\]]*|(?<!\d)\.[」』”）)"'’\]]*(?=\s)|$)/gu)?.filter(Boolean) ?? []
  const result: Piece[] = []
  for (const piece of pieces) {
    const trimmed = piece.trim()
    if (!trimmed) continue
    const last = result.at(-1)
    const separator = /^\s/.test(piece) ? ' ' : ''
    if (last && length(last.text + separator + trimmed) <= maxChars) last.text += separator + trimmed
    else result.push({ text: trimmed, glue: result.length ? separator : '\n' })
  }
  return result
}

/** 按连续分组的最小平方误差分配条数，避免尾条集中承受多余内容。 */
function balance(parts: Piece[], count: number): string[] {
  const sums = [0]
  for (const part of parts) sums.push(sums.at(-1)! + length(part.text) + 1)
  const target = sums.at(-1)! / count
  const costs = Array.from({ length: count + 1 }, () => Array<number>(parts.length + 1).fill(Infinity))
  const cuts = Array.from({ length: count + 1 }, () => Array<number>(parts.length + 1).fill(0))
  costs[0]![0] = 0
  for (let group = 1; group <= count; group++) {
    for (let end = group; end <= parts.length; end++) {
      for (let start = group - 1; start < end; start++) {
        const cost = costs[group - 1]![start]! + (sums[end]! - sums[start]! - target) ** 2
        if (cost < costs[group]![end]!) {
          costs[group]![end] = cost
          cuts[group]![end] = start
        }
      }
    }
  }
  const result: string[] = []
  let end = parts.length
  for (let group = count; group > 0; group--) {
    const start = cuts[group]![end]!
    result.unshift(joinPieces(parts.slice(start, end)))
    end = start
  }
  return result
}

export function splitBurst(
  text: string,
  { mode, maxParts, maxChars = 40 }: { mode: 'lines' | 'sentences'; maxParts: number; maxChars?: number },
): string[] {
  const parts = blocks(text).flatMap((block): Piece[] =>
    mode === 'sentences' && !block.whole && length(block.text) > maxChars
      ? sentences(block.text, maxChars)
      : [{ text: block.text, glue: '\n' }],
  )
  // 过短的碎片并进相邻条；合并后的条仍记着自己的 glue，再次合并时同一行的句子不会被换行隔开。
  const merged: Piece[] = []
  let leading: Piece[] = []
  for (const part of parts) {
    const last = merged.at(-1)
    if (meaningfulLength(part.text) <= 3 && last) last.text += part.glue + part.text
    else if (meaningfulLength(part.text) <= 3) leading.push(part)
    else {
      merged.push(leading.length ? { text: joinPieces([...leading, part]), glue: leading[0]!.glue } : { ...part })
      leading = []
    }
  }
  if (leading.length) merged.push({ text: joinPieces(leading), glue: leading[0]!.glue })
  const count = Math.max(1, Math.floor(maxParts))
  return merged.length > count ? balance(merged, count) : merged.map((piece) => piece.text)
}

export function burstSeed(id: string): number {
  return hashString(id) || 1
}

export function burstDelays(parts: string[], { speed }: { speed: 'fast' | 'medium' | 'slow' }, seed: number): number[] {
  const random = seededRandom(seed)
  const rate = { fast: 12, medium: 7, slow: 4 }[speed]
  return parts.map((part, index) =>
    index === 0 ? 0 : Math.round(Math.max(800, Math.min(6000, (length(part) / rate) * 1000 * (0.75 + random() * 0.5)))),
  )
}
