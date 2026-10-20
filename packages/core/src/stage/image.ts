import type { Expression } from '@nobot/shared'

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
  backdrop: 'green' | 'white' = 'white',
): string {
  const tags = Object.hasOwn(EXPRESSION_TAGS, expression)
    ? EXPRESSION_TAGS[expression as Expression]
    : expression.replace(/[_-]/g, ' ')
  const background =
    backdrop === 'green'
      ? "plain solid chroma-key green (#00FF00) background, no green in the character's clothing or lighting"
      : 'plain pure white background'
  const framing = `Single visual novel character sprite, full body visible from head to shoes, centered with clear margins above the head and below the feet, eye-level camera, relaxed upright pose, arms slightly separated from torso, hands fully visible, consistent proportions, ${background}, flat even lighting, no cast shadow, no scenery, no text, no border, no collage. Preserve the same character design and outfit across expressions.`
  return style === 'tags'
    ? `${[
        appearance,
        outfit,
        tags,
        `full body, standing, ${backdrop === 'green' ? 'green background, chroma key' : 'simple white background'}, no other characters`,
      ]
        .filter(Boolean)
        .join(', ')}. ${framing}`
    : `${appearance}. ${outfit ? `Wearing ${outfit}. ` : ''}Facial expression: ${tags}. Full body, standing, on a ${background}, with no other characters. ${framing}`
}

export interface BackgroundOptions {
  inner?: number
  outer?: number
}

function validate(rgba: Uint8Array, w: number, h: number) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || rgba.length !== w * h * 4)
    throw new RangeError('Invalid RGBA dimensions')
}

function border(w: number, h: number, visit: (i: number) => void) {
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) visit(y * w + x)
}

/** 使用整圈中位数抵抗角落污染、阴影和少量压缩噪声。 */
function estimateBackground(rgba: Uint8Array, w: number, h: number): number[] {
  return [0, 1, 2].map((c) => {
    const values: number[] = []
    border(w, h, (i) => {
      values.push(rgba[i * 4 + c]!)
    })
    values.sort((a, b) => a - b)
    return (values[Math.floor((values.length - 1) / 2)]! + values[Math.floor(values.length / 2)]!) / 2
  })
}

export function hasTransparentBackground(rgba: Uint8Array, w: number, h: number): boolean {
  validate(rgba, w, h)
  let total = 0
  let clear = 0
  border(w, h, (i) => {
    total++
    if (rgba[i * 4 + 3]! < 16) clear++
  })
  return clear / total > 0.9
}

/** 遮罩是 0–1 的前景覆盖率；反解混色只处理半透明边缘，避免改变实心区域。 */
export function applyAlphaMask(
  rgba: Uint8Array,
  w: number,
  h: number,
  mask: ArrayLike<number>,
  background?: readonly number[],
): Uint8Array {
  validate(rgba, w, h)
  if (mask.length !== w * h) throw new RangeError('Invalid alpha mask dimensions')
  const bg = background ?? estimateBackground(rgba, w, h)
  const out = new Uint8Array(rgba)
  for (let i = 0; i < mask.length; i++) {
    const a = Math.max(0, Math.min(1, mask[i]!))
    out[i * 4 + 3] = Math.round(rgba[i * 4 + 3]! * a)
    if (a > 0 && a < 1)
      for (let c = 0; c < 3; c++)
        out[i * 4 + c] = Math.round(Math.max(0, Math.min(255, (rgba[i * 4 + c]! - (1 - a) * bg[c]!) / a)))
  }
  return out
}

export function removeSpriteBackground(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: BackgroundOptions = {},
): Uint8Array {
  validate(rgba, width, height)
  const { inner = 48, outer = 160 } = options
  if (!Number.isFinite(inner) || !Number.isFinite(outer) || inner < 0 || outer <= inner)
    throw new RangeError('Invalid background thresholds')
  const n = width * height
  const bg = estimateBackground(rgba, width, height)
  // RGB 欧氏距离与混色比例单调，便于用同一软阈值处理白底和彩色幕布。
  const distance = (i: number) => Math.hypot(...bg.map((v, c) => rgba[i * 4 + c]! - v))
  const neighbors = (i: number, visit: (j: number) => void) => {
    if (i % width) visit(i - 1)
    if (i % width < width - 1) visit(i + 1)
    if (i >= width) visit(i - width)
    if (i < n - width) visit(i + width)
  }
  const mask = new Float32Array(n).fill(1)
  const seen = new Uint8Array(n)
  const queue: number[] = []
  const visit = (i: number) => {
    if (seen[i] || (rgba[i * 4 + 3] !== 0 && distance(i) >= outer)) return
    seen[i] = 1
    queue.push(i)
  }
  border(width, height, visit)
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!
    const t = Math.max(0, Math.min(1, (distance(i) - inner) / (outer - inner)))
    mask[i] = t * t * (3 - 2 * t)
    neighbors(i, visit)
  }
  // 饱和度超过 45% 且通道跨度超过 80 才视为彩色幕布；白灰底不移除封闭区域。
  const max = Math.max(...bg)
  const colored = max - Math.min(...bg) > 80 && (max - Math.min(...bg)) / max > 0.45
  if (colored) {
    for (let i = 0; i < n; i++) {
      if (seen[i] || distance(i) > inner) continue
      const region = [i]
      seen[i] = 1
      for (let head = 0; head < region.length; head++)
        neighbors(region[head]!, (j) => {
          if (!seen[j] && distance(j) <= inner) {
            seen[j] = 1
            region.push(j)
          }
        })
      if (region.length >= Math.max(64, n * 0.0002)) for (const j of region) mask[j] = 0
    }
  }
  const out = applyAlphaMask(rgba, width, height, mask, bg)
  if (colored) {
    const band = new Uint8Array(n).fill(255)
    const edge: number[] = []
    for (let i = 0; i < n; i++)
      if (out[i * 4 + 3] === 0) {
        band[i] = 0
        edge.push(i)
      }
    for (let head = 0; head < edge.length; head++) {
      const i = edge[head]!
      if (band[i]! >= 3) continue
      neighbors(i, (j) => {
        if (band[j] === 255) {
          band[j] = band[i]! + 1
          edge.push(j)
        }
      })
    }
    const dominant = bg.indexOf(max)
    for (let i = 0; i < n; i++)
      if (band[i]! <= 3) {
        const others = [0, 1, 2].filter((c) => c !== dominant).map((c) => out[i * 4 + c]!)
        out[i * 4 + dominant] = Math.min(out[i * 4 + dominant]!, Math.max(...others))
      }
  }
  seen.fill(0)
  const regions: number[][] = []
  for (let i = 0; i < n; i++) {
    if (seen[i] || out[i * 4 + 3] === 0) continue
    const region = [i]
    seen[i] = 1
    for (let head = 0; head < region.length; head++)
      neighbors(region[head]!, (j) => {
        if (!seen[j] && out[j * 4 + 3] !== 0) {
          seen[j] = 1
          region.push(j)
        }
      })
    regions.push(region)
  }
  const largest = regions.reduce<number[]>((a, b) => (a.length >= b.length ? a : b), [])
  for (const region of regions)
    if (region !== largest && region.length < n * 0.0005) for (const i of region) out[i * 4 + 3] = 0
  return out
}
