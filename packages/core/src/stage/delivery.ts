import { CUES, type Cue, type LineDelivery, type SpokenLine } from '@nobot/shared'
import { stageDirectives } from './scan'

const cueAliases: Readonly<Record<string, Cue>> = {
  laughs: 'laugh',
  laughing: 'laugh',
  chuckles: 'chuckle',
  chuckling: 'chuckle',
  giggle: 'chuckle',
  giggles: 'chuckle',
  giggling: 'chuckle',
  sighs: 'sigh',
  sighing: 'sigh',
  gasps: 'gasp',
  gasping: 'gasp',
  breathes: 'breath',
  breathing: 'breath',
  sobs: 'sob',
  sobbing: 'sob',
  coughs: 'cough',
  coughing: 'cough',
  inhales: 'inhale',
  exhales: 'exhale',
  pants: 'pant',
  panting: 'pant',
  groans: 'groan',
  groaning: 'groan',
  yawns: 'yawn',
  yawning: 'yawn',
  sniffs: 'sniff',
  sniffing: 'sniff',
  sniffles: 'sniff',
  sneezes: 'sneeze',
  sneezing: 'sneeze',
}
const volumeAliases: Readonly<Record<string, 'whisper' | 'shout'>> = {
  whisper: 'whisper',
  whispering: 'whisper',
  shout: 'shout',
  shouting: 'shout',
  screaming: 'shout',
  yelling: 'shout',
  scream: 'shout',
  yell: 'shout',
}
const htmlTags = new Set(
  'b i u s em strong small mark del ins sub sup code pre br p span div q blockquote ruby rt rp details summary font center hr a img ul ol li table tr td th thead tbody'.split(
    ' ',
  ),
)

/** 朗读清理前保护所有演绎标记，避免显示层提前消费声音事件和音量范围。 */
export const deliveryTokenSource = `<\\/?(?:${[...CUES, ...Object.keys(cueAliases), ...Object.keys(volumeAliases)].join('|')})\\s*\\/?>|<pause\\b[^>]*>|\\[(?:whispers|whispering|shouts|shouting|pause|short pause|long pause)\\]|\\((?:whispering|shouting)\\)`

// 两个入口共用扫描和分类，确保历史规范化不会误改显示层保留的标签。
const deliveryPattern =
  /<pause\b[^>]*\/>|<\/?[a-z]+(?:-[a-z]+)*\s*\/?>|\[(?:whispers|whispering|shouts|shouting|pause|short pause|long pause)\]|\((?:whispering|shouting)\)/gi

function classifyDeliveryToken(token: string) {
  const lower = token.toLowerCase()
  const name = /^<\/?([a-z-]+)/.exec(lower)?.[1]
  const preserve = !!name && (stageDirectives.has(name) || htmlTags.has(name))
  const cue =
    name &&
    (CUES.includes(name as Cue) ? (name as Cue) : Object.hasOwn(cueAliases, name) ? cueAliases[name] : undefined)
  const volume = name && Object.hasOwn(volumeAliases, name) && volumeAliases[name]
  const pause = name === 'pause' || lower.includes('pause]')
  const validPause = name !== 'pause' || /^<pause(?:\s+ms=["']\d+["'])?\s*\/>$/.test(lower)
  const closing = lower.startsWith('</')
  const openingVolume = /^<[a-z]+\s*>$/.test(lower)
  const unknownSelfClosing = /^<[a-z]+(?:-[a-z]+)*\s*\/>$/.test(token)
  return { lower, name, preserve, cue, volume, pause, validPause, closing, openingVolume, unknownSelfClosing }
}

/** 只规范化演绎标记本身，让模型历史不再示范畸形语法，正文和其他标记保持原样。 */
export function normalizeDeliveryTags(text: string): string {
  return text.replace(deliveryPattern, (token) => {
    const info = classifyDeliveryToken(token)
    if (info.preserve) return token
    if (info.cue) {
      if (info.closing) return ''
      return info.name === info.cue && token.endsWith('/>') ? token : `<${info.cue}/>`
    }
    if (info.pause) return info.validPause ? token : ''
    if (info.volume) {
      if (!info.closing && !info.openingVolume) return ''
      if (info.name === info.volume) return token
      return `<${info.closing ? '/' : ''}${info.volume}>`
    }
    if (!info.lower.startsWith('<') || info.unknownSelfClosing) return ''
    return token
  })
}

export function parseCues(source: string): SpokenLine {
  const line: SpokenLine = { text: '', cues: [] }
  const spans: NonNullable<SpokenLine['spans']> = []
  const pauses: NonNullable<SpokenLine['pauses']> = []
  const stack: { start: number; volume: 'whisper' | 'shout' }[] = []
  let cursor = 0
  for (const match of source.matchAll(deliveryPattern)) {
    const token = match[0]
    const { lower, preserve, cue, volume, pause, validPause, closing, openingVolume, unknownSelfClosing } =
      classifyDeliveryToken(token)
    line.text += source.slice(cursor, match.index)
    cursor = match.index + token.length
    const at = line.text.length
    if (preserve) {
      line.text += token
      continue
    }
    if (cue) {
      if (!closing) line.cues.push({ at, cue })
    } else if (pause) {
      // 无效停顿同样消费，避免错误参数变成待朗读的控制词。
      if (!validPause) continue
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
    } else if (volume || !lower.startsWith('<')) {
      const resolvedVolume = volume || (lower.includes('whisp') ? 'whisper' : 'shout')
      if (closing) {
        const index = stack.findLastIndex((span) => span.volume === resolvedVolume)
        const span = stack[index]
        if (span) {
          spans.push({ ...span, end: at })
          stack.splice(index, 1)
        }
      } else if (openingVolume) {
        stack.push({ start: at, volume: resolvedVolume })
      } else {
        // 兼容自闭合和别名时固定为整条台词，位置不影响范围；最后一个生效。
        line.volume = resolvedVolume
      }
    } else if (!unknownSelfClosing) {
      // 未知标签只清理小写自闭合写法：成对的可能是角色卡自定义标记，连同普通比较符一起保留。
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
