import type { Cue, Delivery, DeliveryCapabilities, EngineDeliveryParams, SpokenLine } from '@nobot/shared'
import { lineVolume, parseCues } from '../stage/delivery'
import { expressionTone, type Tone } from './expression-tone'

export { parseCues } from '../stage/delivery'

export function sanitizeForEngine(text: string, capabilities: DeliveryCapabilities): string {
  text = parseCues(text).text
  if (['eleven-tags', 'fish-s2', 'cosyvoice'].includes(capabilities.format ?? ''))
    return text.replace(/\[([^\]]*)\]/g, '【$1】')
  if (['fish-s1', 'minimax'].includes(capabilities.format ?? ''))
    return text.replace(/\(([a-z]+(?:[ -][a-z]+)*)\)/gi, '（$1）')
  return text
}

export function toneInstruction(
  tone: Tone,
  intensity: Delivery['intensity'] = 2,
  volume: Delivery['volume'] = 'normal',
  direction = '',
  style = '',
): string {
  return [
    `Speak in a ${intensity === 1 ? 'slightly ' : intensity === 3 ? 'very ' : ''}${tone} tone.`,
    volume === 'whisper' ? 'Whisper.' : volume === 'shout' ? 'Shout.' : '',
    direction,
    style,
  ]
    .filter(Boolean)
    .join(' ')
}

export function deliveryFromExpression(expression?: string): Delivery {
  return { tone: expressionTone(expression), intensity: 2, volume: 'normal', direction: '' }
}

const elevenCues: Partial<Record<Cue, string>> = {
  laugh: 'laughs',
  chuckle: 'chuckles',
  sigh: 'sighs',
  gasp: 'gasps',
  breath: 'breathes',
  sob: 'sobbing',
  cough: 'coughs',
  'clear-throat': 'clears throat',
  exhale: 'exhales',
}
const fishCues: Partial<Record<Cue, string>> = {
  laugh: 'laughing',
  chuckle: 'chuckling',
  sigh: 'sighing',
  gasp: 'gasping',
  sob: 'sobbing',
  groan: 'groaning',
  pant: 'panting',
  yawn: 'yawning',
}
const miniCues: Partial<Record<Cue, string>> = {
  laugh: 'laughs',
  chuckle: 'chuckle',
  sigh: 'sighs',
  gasp: 'gasps',
  breath: 'breath',
  sniff: 'sniffs',
  inhale: 'inhale',
  exhale: 'exhale',
  pant: 'pant',
  groan: 'groans',
  sneeze: 'sneezes',
  cough: 'coughs',
  'clear-throat': 'clear-throat',
}

/** 应用标记先解析，原文先转义，再按清理后的偏移插入已确认的引擎标记。 */
export function renderDelivery(
  capabilities: DeliveryCapabilities,
  delivery: Delivery | undefined,
  line: SpokenLine,
  style = '',
): { text: string; params: EngineDeliveryParams } {
  const parsed = parseCues(line.text)
  // 同时兼容结构化调用和直接传入带标记正文的旧调用。
  line = {
    ...line,
    ...parsed,
    cues: parsed.cues.length ? parsed.cues : line.cues,
    spans: parsed.spans ?? line.spans,
    pauses: parsed.pauses ?? line.pauses,
    volume: parsed.volume ?? line.volume,
  }
  const volume = lineVolume(line)
  if (volume) delivery = { ...deliveryFromExpression(), ...delivery, volume }
  const params: EngineDeliveryParams = {}
  const format = capabilities.format
  const wrap = (tag: string) => (format === 'fish-s1' || format === 'minimax' ? `(${tag})` : `[${tag}]`)
  const prefix: string[] = []
  let cueMap: Partial<Record<Cue, string>> = {}
  if (format === 'eleven-tags') cueMap = elevenCues
  if (format === 'fish-s2') cueMap = { ...fishCues, 'clear-throat': 'clear throat' }
  if (format === 'fish-s1') cueMap = fishCues
  if (format === 'minimax') cueMap = miniCues
  if (format === 'cosyvoice')
    cueMap = { laugh: 'laughter', breath: 'breath', cough: 'cough', sigh: 'sigh', gasp: 'quick_breath' }
  if (delivery) {
    const { tone, intensity, volume, direction } = delivery
    const strength = intensity === 1 ? 'slightly ' : intensity === 3 ? 'very ' : ''
    if (format === 'openai' || (format === 'cosyvoice' && capabilities.emotion === 'instruction'))
      params.instructions = toneInstruction(tone, intensity, volume, direction, style)
    if (format === 'eleven-tags' || format === 'fish-s2' || format === 'fish-s1') {
      if (tone !== 'neutral')
        prefix.push(
          wrap(
            `${format === 'fish-s1' ? '' : strength}${format === 'fish-s1' && tone === 'fearful' ? 'scared' : tone}${format === 'fish-s2' ? ' tone' : ''}`,
          ),
        )
      if (volume !== 'normal' && capabilities.volume)
        prefix.push(
          wrap(
            format === 'eleven-tags'
              ? volume === 'whisper'
                ? 'whispers'
                : 'shouts'
              : volume === 'whisper'
                ? 'whispering'
                : 'shouting',
          ),
        )
      // 自由说明里的括号不能闭合生成的标签。
      if ((direction || style) && capabilities.direction && format !== 'fish-s1')
        prefix.push(wrap((direction || style).replace(/[[\]]/g, '')))
    }
    if (format === 'eleven-settings' && tone !== 'neutral' && tone !== 'calm')
      params.voiceSettings = { style: [0.2, 0.45, 0.7][intensity - 1]!, stability: [0.6, 0.45, 0.3][intensity - 1]! }
    if (format === 'minimax') {
      if (tone !== 'neutral') params.emotion = tone
      if (volume === 'whisper' && capabilities.volume) params.emotion = 'whisper'
    }
    if (format === 'volcengine') {
      params.emotion =
        ({ fearful: 'fear', disgusted: 'hate', calm: 'neutral' } as Partial<Record<Tone, string>>)[tone] ?? tone
      params.emotionScale = [2, 4, 5][intensity - 1]
      if (capabilities.direction) params.contextTexts = [toneInstruction(tone, intensity, volume, direction, style)]
    }
    if (format === 'gptsovits') params.tone = tone
    if (format === 'prosody') {
      const scale = intensity / 2
      const rate = tone === 'sad' ? -0.08 : tone === 'angry' || tone === 'fearful' ? 0.06 : tone === 'happy' ? 0.04 : 0
      const pitch = tone === 'sad' ? -0.04 : tone === 'happy' ? 0.03 : 0
      params.prosody = {
        rate: 1 + rate * scale,
        pitch: 1 + pitch * scale,
        volume:
          (1 + (tone === 'angry' ? 0.1 * scale : 0)) * (volume === 'whisper' ? 0.6 : volume === 'shout' ? 1.25 : 1),
      }
    }
  }
  if (format === 'openai' && capabilities.cues.length && line.cues.length) {
    const instructions = line.cues
      .filter(({ cue }) => capabilities.cues.includes(cue))
      .map(
        ({ at, cue }) =>
          `Include a ${cue} at character offset ${at}, before ${JSON.stringify(line.text.slice(at, at + 24))}.`,
      )
    if (instructions.length) params.instructions = [params.instructions, ...instructions].filter(Boolean).join(' ')
  }
  const sanitized = sanitizeForEngine(line.text, capabilities)
  let text = ''
  let start = 0
  const insertions = [
    ...line.cues.map(({ at, cue }) => ({
      at,
      token: capabilities.cues.includes(cue) && cueMap[cue] ? wrap(cueMap[cue]!) : '',
    })),
    ...(line.pauses ?? []).map(({ at, ms }) => {
      let token = ''
      if (format === 'eleven-settings') token = `<break time="${Math.min(3000, ms) / 1000}s"/>`
      if (format === 'eleven-tags') token = ms >= 1000 ? '[long pause]' : '[short pause]'
      if (format === 'fish-s1' || format === 'fish-s2') token = wrap(ms >= 1000 ? 'long-break' : 'break')
      // MiniMax 停顿必须在可读文字之间；重复停顿只保留第一个，不能连续输出。
      if (
        format === 'minimax' &&
        /[\p{L}\p{N}]/u.test(line.text.slice(0, at)) &&
        /[\p{L}\p{N}]/u.test(line.text.slice(at))
      )
        token = `<#${Math.min(99990, Math.max(10, ms)) / 1000}#>`
      // 其余已接入协议没有可核实的定点停顿能力，直接移除，不插静音或猜测 SSML。
      return { at, token, pause: true }
    }),
  ].sort((a, b) => a.at - b.at)
  let lastPauseAt: number | undefined
  for (const insertion of insertions) {
    const { at, token } = insertion
    if (at < start || at > line.text.length) continue
    text += sanitized.slice(start, at)
    if (
      !('pause' in insertion) ||
      lastPauseAt === undefined ||
      (at !== lastPauseAt && (format !== 'minimax' || /[\p{L}\p{N}]/u.test(line.text.slice(lastPauseAt, at))))
    ) {
      text += token
      if ('pause' in insertion && token) lastPauseAt = at
    }
    start = at
  }
  text += sanitized.slice(start)
  return { text: (prefix.length ? `${prefix.join(' ')} ` : '') + text, params }
}
