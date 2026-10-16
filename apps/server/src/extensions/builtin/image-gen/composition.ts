import { cleanPrompt, type Mode } from './modes'
import { orientResolution, resolutionOptions } from './options'
import type { Settings } from './settings'

export function dimensions(settings: Settings, landscape?: boolean, mode?: string) {
  const override = settings.modeOverrides.find((item) => item.enabled && item.mode === mode)
  if (override?.width && override.height) return { width: override.width, height: override.height }
  const preset = resolutionOptions.find((item) => item.value === settings.resolution)
  return orientResolution(
    preset?.width ?? settings.width,
    preset?.height ?? settings.height,
    landscape === undefined ? undefined : landscape ? 'landscape' : 'portrait',
    settings.snapResolution,
  )
}
export function composePrompt(
  settings: Settings,
  mode: string,
  text: string,
  character: { positive?: string; negative?: string },
  extraNegative = '',
) {
  const style =
    settings.modeOverrides.find((item) => item.enabled && item.mode === mode) ??
    settings.styles.find((item) => item.name === settings.activeStyle) ??
    settings.styles[0]
  const prompt = cleanPrompt(text, settings.minimalProcessing)
  const body = [character.positive, prompt].filter(Boolean).join(', ')
  const prefix = style?.promptPrefix.trim() ?? ''
  const positive = prefix.includes('{prompt}')
    ? prefix.replaceAll('{prompt}', body)
    : [prefix, body].filter(Boolean).join(', ')
  return {
    prompt: [positive, style?.promptSuffix.trim()].filter(Boolean).join(', '),
    negative: [style?.negativePrompt.trim(), character.negative, extraNegative.trim()].filter(Boolean).join(', '),
    rawPrompt: prompt,
  }
}
export function characterPrompt(mode: string, extensions: Record<string, unknown>, group: boolean) {
  const value = extensions.sd_character_prompt
  if (['user', 'background', 'free'].includes(mode) || (group && !['character', 'face'].includes(mode))) return {}
  if (!value || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  return {
    positive: typeof record.positive === 'string' ? record.positive : '',
    negative: typeof record.negative === 'string' ? record.negative : '',
  }
}
export function matchInteractive(text: string): { mode: Mode; input?: string } | null {
  const english = text.match(
    /\b(send|mail|imagine|generate|make|create|draw|paint|render|show)\b.{0,10}\b(pic|picture|image|drawing|painting|photo|photograph)\b(?:\s+of)?(?:\s+(?:a|an|the|this|that|those|your)?\s+)?(.+)/i,
  )
  const chinese = text.match(/(?:发|来|画|生成|给我|做|整)[^。！？\n]{0,30}?(?:图片|照片|自拍|头像|立绘|图|画)(.*)$/)
  if (!english && !chinese) return null
  let subject = (english?.[3] ?? chinese?.[1] ?? '')
    .trim()
    .replace(/^[：:，,的\s]+/, '')
    .replace(/[。！!？?]+$/, '')
    .trim()
    .toLowerCase()
  if (!english) {
    const before = text.slice(0, text.length - (chinese?.[1]?.length ?? 0))
    if (!subject)
      subject = /自拍|头像/.test(before)
        ? '自拍'
        : before
            .replace(/^(?:请|麻烦)?(?:给我|生成|画|发|来|做|整)+/, '')
            .replace(/(?:一|几)?(?:张|幅|个)?|图片|照片|立绘|图|画|的/g, '')
            .trim() || '你'
  }
  const mappings: [RegExp, Mode][] = [
    [/^(?:自拍|脸|头像|face|portrait|selfie)$/, 'face'],
    [/^(?:你|你自己|you|yourself)$/, 'character'],
    [/^(?:我|我自己|me|myself)$/, 'user'],
    [/^(?:场景|整个故事|story|scenario|whole story)$/, 'scene'],
    [/^(?:上一条|刚才|last message)$/, 'last'],
    [/^(?:背景|环境|周围|background|scene background|scene|scenery|surroundings|environment)$/, 'background'],
  ]
  const mode = mappings.find(([pattern]) => pattern.test(subject))?.[1]
  return mode ? { mode } : { mode: 'free', input: subject }
}
