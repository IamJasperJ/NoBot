import type { SpriteCandidate } from './index'

export function spriteNameFromPath(path: string): { outfit: string; expression: string } | null {
  const parts = path.replaceAll('\\', '/').split('/')
  const file = parts.pop() ?? ''
  if (file.startsWith('.') || parts.includes('__MACOSX')) return null
  const stem = file.replace(/\.[^.]*$/, '')
  const expression = stem.split(/[.-]/)[0]!.toLowerCase()
  return /^[a-z0-9_]+$/.test(expression) ? { outfit: parts.at(-1) ?? '', expression } : null
}

export function pickSprite<T extends SpriteCandidate>(
  sprites: T[],
  opts: {
    expression: string
    outfit: string
    fallback: string
    random: boolean
    seed: string
    avoidId?: string
    previousId?: string
    rerollSame?: boolean
  },
): T | null {
  for (const expression of [opts.expression, opts.fallback]) {
    if (!expression) continue
    for (const outfit of [...new Set([opts.outfit, ''])]) {
      let candidates = sprites.filter((sprite) => sprite.outfit === outfit && sprite.expression === expression)
      if (!candidates.length) continue
      const avoidId = opts.rerollSame ? (opts.previousId ?? opts.avoidId) : opts.avoidId
      if (candidates.some((sprite) => sprite.id !== avoidId))
        candidates = candidates.filter((sprite) => sprite.id !== avoidId)
      let hash = 2166136261
      for (const char of opts.seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
      return candidates[opts.random ? hash % candidates.length : 0]!
    }
  }
  return null
}

export function extractExpressionLabel(answer: string, labels: string[]): string | null {
  const text = answer.toLowerCase()
  const words = text.split(/[^a-z0-9_]+/)
  return (
    labels.find((label) => words.includes(label.toLowerCase())) ??
    [...labels].sort((a, b) => b.length - a.length).find((label) => text.includes(label.toLowerCase())) ??
    null
  )
}
