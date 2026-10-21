import type { Cue, Delivery, DeliveryCapabilities, EngineDeliveryParams, SpokenLine } from '@nobot/shared'
import { expressionTone, type Tone } from './expression-tone'

export { parseCues } from './stage/delivery'

export function sanitizeForEngine(text: string, capabilities: DeliveryCapabilities): string {
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

const elevenCues: Record<Cue, string> = {
  laugh: 'laughs',
  chuckle: 'chuckles',
  sigh: 'sighs',
  gasp: 'gasps',
  breath: 'breathes',
  sob: 'sobbing',
  cough: 'coughs',
  'clear-throat': 'clears throat',
}
const fishCues: Partial<Record<Cue, string>> = {
  laugh: 'laughing',
  chuckle: 'chuckling',
  sigh: 'sighing',
  gasp: 'gasping',
  sob: 'sobbing',
}
const miniCues: Record<Cue, string> = {
  laugh: 'laughs',
  chuckle: 'chuckle',
  sigh: 'sighs',
  gasp: 'gasps',
  breath: 'breath',
  sob: 'sniffs',
  cough: 'coughs',
  'clear-throat': 'clear-throat',
}

/** 先转义原文再插标签；全角括号长度不变，因此原始插入点仍然准确。 */
export function renderDelivery(
  capabilities: DeliveryCapabilities,
  delivery: Delivery | undefined,
  line: SpokenLine,
  style = '',
): { text: string; params: EngineDeliveryParams } {
  const params: EngineDeliveryParams = {}
  const format = capabilities.format
  const wrap = (tag: string) => (format === 'fish-s1' || format === 'minimax' ? `(${tag})` : `[${tag}]`)
  const prefix: string[] = []
  let cueMap: Partial<Record<Cue, string>> = {}
  if (format === 'eleven-tags') cueMap = elevenCues
  if (format === 'fish-s2') cueMap = fishCues
  if (format === 'fish-s1') cueMap = { laugh: 'laughing', sigh: 'sighing' }
  if (format === 'minimax') cueMap = miniCues
  if (format === 'cosyvoice') cueMap = { laugh: 'laughter', breath: 'breath' }
  if (delivery) {
    const { tone, intensity, volume, direction } = delivery
    const strength = intensity === 1 ? 'slightly ' : intensity === 3 ? 'very ' : ''
    if (format === 'openai' || format === 'cosyvoice')
      params.instructions = toneInstruction(tone, intensity, volume, direction, style)
    if (format === 'eleven-tags' || format === 'fish-s2' || format === 'fish-s1') {
      if (tone !== 'neutral' && (format !== 'fish-s1' || ['happy', 'sad', 'angry'].includes(tone)))
        prefix.push(wrap(`${format === 'fish-s1' ? '' : strength}${tone}${format === 'fish-s2' ? ' tone' : ''}`))
      if (volume !== 'normal' && capabilities.volume)
        prefix.push(wrap(volume === 'whisper' ? 'whispering' : 'shouting'))
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
      // 这是 TTS 的语音指令，固定中文对话句式比英文更稳定，不属于 LLM 提示词。
      const moods: Record<Tone, string> = {
        happy: '开心',
        sad: '痛心',
        angry: '生气',
        fearful: '害怕',
        disgusted: '厌恶',
        surprised: '惊讶',
        calm: '平静',
        neutral: '自然',
      }
      if (capabilities.direction)
        params.contextTexts = [
          `你可以用${['稍微', '', '特别特别'][intensity - 1]}${moods[tone]}的语气说吗？`,
          ...(volume === 'whisper' ? ['你嗓门再小点。'] : volume === 'shout' ? ['你可以大声喊出来吗？'] : []),
          ...(direction ? [direction] : []),
          ...(style ? [style] : []),
        ]
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
  for (const { at, cue } of line.cues) {
    if (at < start || at > line.text.length) continue
    text += sanitized.slice(start, at)
    const tag = capabilities.cues.includes(cue) ? cueMap[cue] : undefined
    if (tag) text += wrap(tag)
    start = at
  }
  text += sanitized.slice(start)
  return { text: (prefix.length ? `${prefix.join(' ')} ` : '') + text, params }
}
