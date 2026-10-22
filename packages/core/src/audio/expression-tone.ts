import { TONES, type Tone } from '@nobot/shared'

export { TONES, type Tone } from '@nobot/shared'

const groups: Record<Tone, readonly string[]> = {
  happy: [
    'joy',
    'amusement',
    'excitement',
    'love',
    'gratitude',
    'optimism',
    'pride',
    'relief',
    'admiration',
    'approval',
    'caring',
    'desire',
  ],
  sad: ['sadness', 'grief', 'disappointment', 'remorse', 'embarrassment'],
  angry: ['anger', 'annoyance', 'disapproval'],
  fearful: ['fear', 'nervousness'],
  disgusted: ['disgust'],
  surprised: ['surprise', 'realization', 'confusion', 'curiosity'],
  calm: [],
  neutral: ['neutral'],
}

/** 固定映射避免把任意表情文本直接作为模型指令；欲望归为积极，尴尬归为低落。 */
export function expressionTone(expression: string | undefined): Tone {
  const name = expression?.trim().toLowerCase()
  return TONES.find((tone) => tone === name || groups[tone].includes(name ?? '')) ?? 'neutral'
}
