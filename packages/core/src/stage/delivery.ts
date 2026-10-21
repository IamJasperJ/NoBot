import type { Cue, LineDelivery, SpokenLine } from '@nobot/shared'

const cuePattern = /<(laugh|chuckle|sigh|gasp|breath|sob|cough|clear-throat)\s*\/>/gi

export function parseCues(text: string): SpokenLine {
  const cues: SpokenLine['cues'] = []
  let removed = 0
  const plain = text.replace(cuePattern, (tag: string, cue: string, at: number) => {
    cues.push({ at: at - removed, cue: cue.toLowerCase() as Cue })
    removed += tag.length
    return ''
  })
  return { text: plain, cues }
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
