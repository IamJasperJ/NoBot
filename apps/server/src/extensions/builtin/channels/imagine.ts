import { t } from '../../../i18n'

export const imagineModes = [
  'character',
  'portrait',
  'face',
  'user',
  'scene',
  'last',
  'raw_last',
  'background',
  'free',
] as const
export type ImagineMode = (typeof imagineModes)[number]
const keywords: Record<string, ImagineMode> = {
  character: 'character',
  char: 'character',
  角色: 'character',
  全身: 'character',
  portrait: 'portrait',
  半身: 'portrait',
  face: 'face',
  脸: 'face',
  头像: 'face',
  特写: 'face',
  me: 'user',
  user: 'user',
  我: 'user',
  人设: 'user',
  scene: 'scene',
  场景: 'scene',
  last: 'last',
  最后: 'last',
  上一条: 'last',
  raw: 'raw_last',
  raw_last: 'raw_last',
  原文: 'raw_last',
  background: 'background',
  bg: 'background',
  背景: 'background',
  free: 'free',
  自由: 'free',
}
const orientations: Record<string, string> = {
  portrait: 'portrait',
  竖: 'portrait',
  landscape: 'landscape',
  横: 'landscape',
  square: 'square',
  方: 'square',
}
/** 只消费开头的模式和独立参数；自由描述中的普通词不应意外切换模式。 */
export function parseImagine(input: string, names: string[]) {
  const tokens = input.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  const unquote = (token: string) => token.replace(/^(["'])(.*)\1$/, '$2')
  const mode = keywords[tokens[0]?.toLowerCase() ?? '']
  if (mode) tokens.shift()
  const hasCharacter = tokens.some((token) => names.includes(unquote(token)))
  if (!mode && !hasCharacter) return { args: { mode: 'free' } as Record<string, string>, text: input.trim() }
  const args: Record<string, string> = { mode: mode ?? 'free' }
  const text: string[] = []
  for (const token of tokens) {
    const value = unquote(token)
    if (!args.character && names.includes(value)) {
      args.character = value
      if (!mode) args.mode = 'character'
    } else if (!args.orientation && orientations[value.toLowerCase()]) {
      args.orientation = orientations[value.toLowerCase()]!
    } else text.push(token)
  }
  return { args, text: text.join(' ') }
}
export function imagineLabel(mode: ImagineMode) {
  switch (mode) {
    case 'character':
      return t('全身')
    case 'portrait':
      return t('半身')
    case 'face':
      return t('脸部特写')
    case 'user':
      return t('用户人设')
    case 'scene':
      return t('当前场景')
    case 'last':
      return t('最后一条消息')
    case 'raw_last':
      return t('最后一条消息原文')
    case 'background':
      return t('背景')
    case 'free':
      return t('自由描述')
  }
}
