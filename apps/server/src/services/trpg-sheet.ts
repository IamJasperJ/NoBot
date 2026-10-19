import { type CharacterSheet, characterSheetSchema } from '@ai-parter/shared'

/** 属性卡跟随角色扩展保存，保留同一命名空间里其他扩展字段。 */
export function readSheet(extensions: Record<string, unknown>): CharacterSheet | null {
  const own = extensions.ai_parter
  if (!own || typeof own !== 'object' || Array.isArray(own)) return null
  return characterSheetSchema.safeParse((own as Record<string, unknown>).sheet).data ?? null
}

export function withSheet(extensions: Record<string, unknown>, sheet: CharacterSheet | null) {
  const own = extensions.ai_parter
  if (sheet === null && (!own || typeof own !== 'object' || !Object.hasOwn(own, 'sheet'))) return extensions
  return {
    ...extensions,
    ai_parter: { ...(own && typeof own === 'object' && !Array.isArray(own) ? own : {}), sheet },
  }
}
