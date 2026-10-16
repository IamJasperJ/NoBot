import { type CharacterExtras, characterExtrasSchema } from '@ai-parter/shared'
import type { CardExportInput } from './index'
import { isObject, object } from './utils'
import { toCharacterBook } from './worldinfo'

export function buildCardExport(input: CardExportInput): { v2: Record<string, unknown>; v3: Record<string, unknown> } {
  const raw = structuredClone(input.raw ?? {})
  const wrapped = raw.spec === 'chara_card_v2' || raw.spec === 'chara_card_v3'
  const data = wrapped && isObject(raw.data) ? raw.data : raw
  Object.assign(data, structuredClone(input.fields))
  data.extensions = {
    ...object(data.extensions),
    talkativeness: input.extras.talkativeness,
    depth_prompt: {
      ...object(object(data.extensions).depth_prompt),
      prompt: input.extras.characterNote,
      depth: input.extras.characterNoteDepth,
      role: input.extras.characterNoteRole,
    },
  }
  if (input.book) data.character_book = toCharacterBook(input.book.name, input.book.entries)
  else delete data.character_book
  const v3Data = structuredClone(data)
  if (!Array.isArray(v3Data.group_only_greetings)) v3Data.group_only_greetings = []
  return {
    v2: { spec: 'chara_card_v2', spec_version: '2.0', data },
    v3: { spec: 'chara_card_v3', spec_version: '3.0', data: v3Data },
  }
}

export function readCardExtras(data: Record<string, unknown>): Partial<CharacterExtras> {
  const extensions = object(data.extensions)
  const note = object(extensions.depth_prompt)
  const talk = extensions.talkativeness
  const input = {
    talkativeness: typeof talk === 'string' && talk.trim() ? Number(talk) : talk,
    characterNote: note.prompt,
    characterNoteDepth: note.depth,
    characterNoteRole: note.role,
  }
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    const parsed = characterExtrasSchema.shape[key as keyof typeof input].safeParse(value)
    if (parsed.success) result[key] = parsed.data
  }
  return result
}
