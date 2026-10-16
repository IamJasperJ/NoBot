import { generationTypeSchema, type LorebookEntryData, lorebookEntryDataSchema } from '@ai-parter/shared'
import {
  enumValue,
  isObject,
  object,
  readMap,
  requireObject,
  STFormatError,
  sanitize,
  strings,
  writeMap,
} from './utils'

const positions = [
  'before_char',
  'after_char',
  'before_an',
  'after_an',
  'at_depth',
  'before_em',
  'after_em',
  'outlet',
] as const
const logics = ['and_any', 'not_all', 'not_any', 'and_all'] as const
const roles = ['system', 'user', 'assistant'] as const
const sources = {
  char_description: 'matchCharacterDescription',
  char_personality: 'matchCharacterPersonality',
  scenario: 'matchScenario',
  persona: 'matchPersonaDescription',
  char_note: 'matchCharacterDepthPrompt',
  creator_notes: 'matchCreatorNotes',
} as const
const fields = {
  comment: 'comment',
  keys: 'key',
  secondaryKeys: 'keysecondary',
  content: 'content',
  constant: 'constant',
  order: 'order',
  depth: 'depth',
  probability: 'probability',
  useProbability: 'useProbability',
  excludeRecursion: 'excludeRecursion',
  preventRecursion: 'preventRecursion',
  delayUntilRecursion: 'delayUntilRecursion',
  group: 'group',
  groupPrioritize: 'groupOverride',
  groupWeight: 'groupWeight',
  groupScoring: 'useGroupScoring',
  scanDepth: 'scanDepth',
  caseSensitive: 'caseSensitive',
  matchWholeWords: 'matchWholeWords',
  sticky: 'sticky',
  cooldown: 'cooldown',
  delay: 'delay',
  automationId: 'automationId',
  vectorized: 'vectorized',
  outletName: 'outletName',
}
const extensionFields = {
  depth: 'depth',
  probability: 'probability',
  useProbability: 'useProbability',
  selectiveLogic: 'selectiveLogic',
  excludeRecursion: 'exclude_recursion',
  preventRecursion: 'prevent_recursion',
  delayUntilRecursion: 'delay_until_recursion',
  matchWholeWords: 'match_whole_words',
  caseSensitive: 'case_sensitive',
  group: 'group',
  groupPrioritize: 'group_override',
  groupWeight: 'group_weight',
  scanDepth: 'scan_depth',
  role: 'role',
  sticky: 'sticky',
  cooldown: 'cooldown',
  delay: 'delay',
  automationId: 'automation_id',
  vectorized: 'vectorized',
  groupScoring: 'use_group_scoring',
  outletName: 'outlet_name',
}

function importEntry(entry: Record<string, unknown>, embedded: boolean): LorebookEntryData {
  const ext = object(entry.extensions)
  const input: Record<string, unknown> = embedded
    ? {
        ...readMap(ext, extensionFields),
        keys: entry.keys,
        secondaryKeys: entry.secondary_keys,
        content: entry.content,
        enabled: entry.enabled,
        order: entry.insertion_order,
        constant: entry.constant,
        comment: typeof entry.comment === 'string' ? entry.comment : entry.name,
        caseSensitive:
          typeof ext.case_sensitive === 'boolean' || ext.case_sensitive === null
            ? ext.case_sensitive
            : entry.case_sensitive,
        position:
          enumValue(ext.position, positions) ?? (entry.position === 'after_char' ? 'after_char' : 'before_char'),
      }
    : {
        ...readMap(entry, fields),
        enabled: typeof entry.disable === 'boolean' ? !entry.disable : undefined,
        position: enumValue(entry.position, positions),
      }
  const extra = embedded ? ext : entry
  const filter = object(extra.characterFilter)
  return sanitize(lorebookEntryDataSchema, {
    ...input,
    keys: strings(input.keys),
    secondaryKeys: strings(input.secondaryKeys),
    selectiveLogic: enumValue(extra.selectiveLogic, logics),
    role: enumValue(extra.role, roles),
    characterFilter: {
      names: strings(filter.names) ?? [],
      exclude: typeof filter.isExclude === 'boolean' ? filter.isExclude : false,
    },
    triggers: strings(extra.triggers)?.filter((t) => generationTypeSchema.safeParse(t).success),
    matchSources: Object.entries(sources)
      .filter(([, field]) => extra[field] === true)
      .map(([source]) => source),
  })
}

export function importSTWorldInfo(json: unknown): { name: string | null; entries: LorebookEntryData[] } {
  const input = requireObject(json)
  const embedded = Array.isArray(input.entries)
  if (!embedded && !isObject(input.entries)) throw new STFormatError('世界书缺少有效的 entries 对象或数组')
  const entries = Array.isArray(input.entries)
    ? input.entries
    : Object.entries(object(input.entries))
        .sort(([ka, a], [kb, b]) => {
          const index = (key: string, value: unknown) => {
            const display = object(value).displayIndex
            if (typeof display === 'number' && Number.isFinite(display)) return display
            return Number.isFinite(Number(key)) ? Number(key) : 0
          }
          return index(ka, a) - index(kb, b)
        })
        .map(([, entry]) => entry)
  if (!entries.every(isObject)) throw new STFormatError('世界书条目必须是 JSON 对象')
  return {
    name: typeof input.name === 'string' ? input.name : null,
    entries: entries.map((entry) => importEntry(entry, embedded)),
  }
}

function extraFields(entry: LorebookEntryData): Record<string, unknown> {
  return {
    position: positions.indexOf(entry.position),
    selectiveLogic: logics.indexOf(entry.selectiveLogic),
    role: roles.indexOf(entry.role),
    characterFilter: { isExclude: entry.characterFilter.exclude, names: [...entry.characterFilter.names] },
    triggers: [...entry.triggers],
    ...Object.fromEntries(
      Object.entries(sources).map(([source, field]) => [
        field,
        entry.matchSources.includes(source as keyof typeof sources),
      ]),
    ),
  }
}

export function exportSTWorldInfo(entries: LorebookEntryData[]): Record<string, unknown> {
  return {
    entries: Object.fromEntries(
      entries.map((entry, uid) => [
        String(uid),
        {
          ...structuredClone(writeMap(entry, fields)),
          ...extraFields(entry),
          uid,
          displayIndex: uid,
          disable: !entry.enabled,
          selective: entry.secondaryKeys.length > 0,
        },
      ]),
    ),
  }
}

export function toCharacterBook(name: string, entries: LorebookEntryData[]): Record<string, unknown> {
  return {
    name,
    entries: entries.map((entry, id) => ({
      id,
      keys: [...entry.keys],
      secondary_keys: [...entry.secondaryKeys],
      content: entry.content,
      enabled: entry.enabled,
      insertion_order: entry.order,
      constant: entry.constant,
      comment: entry.comment,
      name: entry.comment,
      case_sensitive: entry.caseSensitive,
      selective: entry.secondaryKeys.length > 0,
      position: entry.position === 'after_char' ? 'after_char' : 'before_char',
      extensions: { ...writeMap(entry, extensionFields), ...extraFields(entry) },
    })),
  }
}
