import type { Expression } from '@ai-parter/shared'

/** 表情标签使用可见的面部特征，避免把抽象情绪直接交给绘图模型。 */
export const EXPRESSION_TAGS: Record<Expression, string> = {
  admiration: 'admiring eyes, sparkling eyes',
  amusement: 'smile, amused',
  anger: 'angry, frown',
  annoyance: 'annoyed, furrowed brow',
  approval: 'smile, approving expression',
  caring: 'gentle smile, tender eyes',
  confusion: 'confused, raised eyebrow',
  curiosity: 'curious, wide eyes',
  desire: 'longing eyes, blush',
  disappointment: 'disappointed, downcast eyes',
  disapproval: 'frown, disapproving expression',
  disgust: 'disgusted, wrinkled nose',
  embarrassment: 'blush, embarrassed',
  excitement: 'excited, open mouth smile',
  fear: 'scared, wide eyes',
  gratitude: 'grateful, warm smile',
  grief: 'crying, tears',
  joy: 'smile, happy',
  love: 'loving gaze, blush, smile',
  nervousness: 'nervous, worried expression',
  optimism: 'hopeful, bright smile',
  pride: 'proud, confident smile',
  realization: 'surprised, eyes widening',
  relief: 'relieved, relaxed smile',
  remorse: 'regretful, downcast eyes',
  sadness: 'sad, frown, downcast eyes',
  surprise: 'surprised, open mouth, wide eyes',
  neutral: 'neutral expression, relaxed face',
}

export function spritePrompt(
  appearance: string,
  expression: string,
  outfit: string,
  style: 'tags' | 'natural',
): string {
  const tags = Object.hasOwn(EXPRESSION_TAGS, expression)
    ? EXPRESSION_TAGS[expression as Expression]
    : expression.replace(/[_-]/g, ' ')
  const framing =
    'Single visual novel character sprite, full body visible from head to shoes, centered with clear margins above the head and below the feet, eye-level camera, relaxed upright pose, arms slightly separated from torso, hands fully visible, consistent proportions, plain pure white background, flat even lighting, no cast shadow, no scenery, no text, no border, no collage. Preserve the same character design and outfit across expressions.'
  return style === 'tags'
    ? `${[appearance, outfit, tags, 'full body, standing, simple white background, no other characters']
        .filter(Boolean)
        .join(', ')}. ${framing}`
    : `${appearance}. ${outfit ? `Wearing ${outfit}. ` : ''}Facial expression: ${tags}. Full body, standing, on a simple white background, with no other characters. ${framing}`
}

/** 只移除从边缘可达的背景，封闭在人物内部的相似颜色（例如白色衣服）保留。 */
export function removeSpriteBackground(rgba: Uint8Array, width: number, height: number, tolerance = 32): Uint8Array {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    rgba.length !== width * height * 4 ||
    !Number.isFinite(tolerance) ||
    tolerance < 0
  )
    throw new RangeError('Invalid RGBA dimensions or tolerance')
  const output = new Uint8Array(rgba)
  const corners = [0, width - 1, (height - 1) * width, width * height - 1]
  const background = [0, 1, 2].map((channel) => {
    const values = corners.map((index) => rgba[index * 4 + channel]!).sort((a, b) => a - b)
    return (values[1]! + values[2]!) / 2
  })
  const removed = new Uint8Array(width * height)
  const queue: number[] = []
  const visit = (index: number) => {
    if (removed[index]) return
    const offset = index * 4
    if (
      rgba[offset + 3] !== 0 &&
      !background.every((value, channel) => Math.abs(rgba[offset + channel]! - value) <= tolerance)
    )
      return
    removed[index] = 1
    queue.push(index)
  }
  for (let x = 0; x < width; x++) {
    visit(x)
    visit((height - 1) * width + x)
  }
  for (let y = 0; y < height; y++) {
    visit(y * width)
    visit(y * width + width - 1)
  }
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head]!
    if (index % width > 0) visit(index - 1)
    if (index % width < width - 1) visit(index + 1)
    if (index >= width) visit(index - width)
    if (index < width * (height - 1)) visit(index + width)
  }
  for (let index = 0; index < removed.length; index++) {
    if (removed[index]) output[index * 4 + 3] = 0
    else {
      // 从掩码而非已修改的 alpha 读取邻域，羽化严格限制为一像素。
      const adjacent = [
        index % width > 0 ? index - 1 : -1,
        index % width < width - 1 ? index + 1 : -1,
        index - width,
        index + width,
      ]
      const count = adjacent.filter(
        (neighbor) => neighbor >= 0 && neighbor < removed.length && removed[neighbor],
      ).length
      if (count) output[index * 4 + 3] = Math.round(rgba[index * 4 + 3]! * (1 - count / 8))
    }
  }
  return output
}
