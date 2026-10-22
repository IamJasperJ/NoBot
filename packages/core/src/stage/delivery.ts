import { CUES, type Cue, type LineDelivery, type SpokenLine } from '@nobot/shared'
import { stageDirectives } from './scan'

/** 仅兼容确切的英文别名，不把普通括号、动作或强调当作控制符。 */
export const deliveryTokenSource = `<\\/?(?:${CUES.join('|')}|whisper|shout|pause)\\b[^>]*>|\\[(?:whispers|whispering|shouts|shouting|pause|short pause|long pause)\\]|\\((?:whispering|shouting)\\)`

export function parseCues(source: string): SpokenLine {
  const line: SpokenLine = { text: '', cues: [] }
  const spans: NonNullable<SpokenLine['spans']> = []
  const pauses: NonNullable<SpokenLine['pauses']> = []
  const stack: { start: number; volume: 'whisper' | 'shout' }[] = []
  const pattern =
    /<\/?(?:whisper|shout)\s*>|<pause\b[^>]*\/>|<[a-z]+(?:-[a-z]+)*\s*\/>|\[(?:whispers|whispering|shouts|shouting|pause|short pause|long pause)\]|\((?:whispering|shouting)\)/gi
  let cursor = 0
  for (const match of source.matchAll(pattern)) {
    const token = match[0]
    const lower = token.toLowerCase()
    line.text += source.slice(cursor, match.index)
    cursor = match.index + token.length
    const at = line.text.length
    const name = /^<\/?([a-z-]+)/.exec(lower)?.[1]
    if (name && stageDirectives.has(name)) {
      line.text += token
      continue
    }
    if (name && CUES.includes(name as Cue)) {
      line.cues.push({ at, cue: name as Cue })
    } else if (name === 'pause' || lower.includes('pause]')) {
      // 无效停顿同样消费，避免错误参数变成待朗读的控制词。
      if (name === 'pause' && !/^<pause(?:\s+ms=["']\d+["'])?\s*\/>$/.test(lower)) continue
      const ms = /ms=["'](\d+)["']/.exec(lower)?.[1]
      // 应用层只存整数毫秒；具体协议上限留给适配器，避免溢出。
      pauses.push({
        at,
        ms: ms
          ? Math.min(99990, Math.max(1, Number(ms)))
          : lower === '[short pause]'
            ? 300
            : lower === '[long pause]'
              ? 1000
              : 500,
      })
    } else if (name === 'whisper' || name === 'shout' || !lower.startsWith('<')) {
      const volume = lower.includes('whisp') ? 'whisper' : 'shout'
      if (lower.startsWith('</')) {
        const index = stack.findLastIndex((span) => span.volume === volume)
        const span = stack[index]
        if (span) {
          spans.push({ ...span, end: at })
          stack.splice(index, 1)
        }
      } else if (/^<(whisper|shout)\s*>$/.test(lower)) {
        stack.push({ start: at, volume })
      } else {
        // 兼容自闭合和别名时固定为整条台词，位置不影响范围；最后一个生效。
        line.volume = volume
      }
    } else if (!/^<[a-z]+(?:-[a-z]+)*\s*\/>$/.test(token)) {
      // 未知标签只清理小写自闭合写法，成对标签及普通比较符保留。
      line.text += token
    }
  }
  line.text += source.slice(cursor)
  for (const span of stack) spans.push({ ...span, end: line.text.length })
  if (spans.length) line.spans = spans.sort((a, b) => a.start - b.start)
  if (pauses.length) line.pauses = pauses
  return line
}

/** 不做句内请求切分：同一音量的范围合计严格过半才退化到整句，否则忽略风格。 */
export function lineVolume(line: SpokenLine): SpokenLine['volume'] {
  if (line.volume) return line.volume
  for (const volume of ['whisper', 'shout'] as const) {
    const ranges = (line.spans ?? []).filter((span) => span.volume === volume)
    let end = 0
    let covered = 0
    for (const span of ranges) {
      covered += Math.max(0, span.end - Math.max(end, span.start))
      end = Math.max(end, span.end)
    }
    if (covered > line.text.length / 2) return volume
  }
}

/** 提取控制词后保留自由说明，不根据自然语言猜测情绪。 */
export function parseLineDelivery(tone: string): LineDelivery {
  const delivery: LineDelivery = {}
  const direction = tone
    .replace(/\b(whisper(?:ing)?|shout(?:ing)?|yelling|slightly|a little|very|extremely)\b/gi, (word) => {
      const value = word.toLowerCase()
      if (/^whisper/.test(value)) delivery.volume = 'whisper'
      else if (/^(shout|yell)/.test(value)) delivery.volume = 'shout'
      else if (value === 'slightly' || value === 'a little') delivery.intensity = 1
      else delivery.intensity = 3
      return ''
    })
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(', ')
    .slice(0, 120)
  if (direction) delivery.direction = direction
  return delivery
}
