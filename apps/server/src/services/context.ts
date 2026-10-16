import {
  type BuildInput,
  buildPrompt,
  type HistoryMessage,
  PromptBudgetError,
  type PromptCharacter,
  type ScanEntry,
} from '@ai-parter/core'
import {
  type ChatMessage,
  type GenerationType,
  type GroupDTO,
  lorebookEntryDataSchema,
  type MessageRole,
  type PresetData,
  type PromptPreview,
  presetDataSchema,
} from '@ai-parter/shared'
import { asc, eq, inArray } from 'drizzle-orm'
import { db, getSetting } from '../db/client'
import {
  type ApiPresetRow,
  type CharacterRow,
  type ChatRow,
  characterLorebooks,
  characters,
  chatLorebooks,
  lorebookEntries,
  lorebooks,
  personas,
  promptPresets,
} from '../db/schema'
import { HttpError, notFound } from '../errors'
import { collectMacros, runAfterPrompt, runBeforePrompt } from '../extensions/registry'
import { getChatRow, loadGroupDTO, loadPath } from './chats'
import { resolveApiPreset } from './connections'
import { getWorldInfoSettings, SETTING_KEYS } from './settings'

/**
 * 生成上下文：组装 Prompt 需要的一切，一次性从数据库读出来。
 * 生成、代写、Prompt 预览都走这里，保证三者看到的东西完全一样。
 * 这一步之后的组装（buildPrompt）是纯函数。
 */
export interface GenerationContext {
  chat: ChatRow
  /** 连接配置（地址、Key、模型）。预览时连接缺失不报错，所以可能为 null */
  connection: ApiPresetRow | null
  preset: PresetData
  persona: { id: string | null; name: string; description: string }
  /** 会话里可能发言的角色：单人会话只有一个，群聊是全部成员（按成员顺序） */
  members: PromptCharacter[]
  group: GroupDTO | null
  loreEntries: ScanEntry[]
}

export function toPromptCharacter(row: CharacterRow, muted = false): PromptCharacter {
  return {
    id: row.id,
    name: row.name,
    muted,
    fields: {
      name: row.name,
      description: row.description,
      personality: row.personality,
      scenario: row.scenario,
      first_mes: row.firstMes,
      alternate_greetings: row.alternateGreetings,
      mes_example: row.mesExample,
      system_prompt: row.systemPrompt,
      post_history_instructions: row.postHistoryInstructions,
      creator_notes: row.creatorNotes,
      tags: row.tags,
      creator: row.creator,
      character_version: row.characterVersion,
    },
    extras: {
      talkativeness: row.talkativeness,
      characterNote: row.characterNote,
      characterNoteDepth: row.characterNoteDepth,
      characterNoteRole: row.characterNoteRole,
      defaultPersonaId: row.defaultPersonaId,
    },
  }
}

/** 会话指定的生成预设 → 全局默认 → 任意一个 → 内置默认值 */
function resolvePreset(chat: ChatRow): PresetData {
  const ids = [chat.promptPresetId, getSetting<string>(SETTING_KEYS.defaultPromptPresetId)].filter(
    (x): x is string => !!x,
  )
  for (const id of ids) {
    const row = db.select().from(promptPresets).where(eq(promptPresets.id, id)).get()
    if (row) return presetDataSchema.parse(row.data)
  }
  const any = db.select().from(promptPresets).orderBy(asc(promptPresets.createdAt)).get()
  return presetDataSchema.parse(any?.data ?? {})
}

function resolvePersona(chat: ChatRow) {
  const id = chat.personaId ?? getSetting<string>(SETTING_KEYS.defaultPersonaId)
  const row = id ? db.select().from(personas).where(eq(personas.id, id)).get() : undefined
  return row
    ? { id: row.id, name: row.name, description: row.description, lorebookId: row.lorebookId }
    : { id: null, name: '旅人', description: '', lorebookId: null }
}

/**
 * 收集挂载的世界书条目。同一本书挂在多处时按优先级只算一次：会话 > 人设 > 角色 > 全局。
 */
function loadLore(chatId: string, characterIds: string[], personaLorebookId: string | null): ScanEntry[] {
  const sources = new Map<string, ScanEntry['source']>()
  const add = (ids: string[], source: ScanEntry['source']) => {
    for (const id of ids) if (!sources.has(id)) sources.set(id, source)
  }
  add(
    db
      .select({ id: chatLorebooks.lorebookId })
      .from(chatLorebooks)
      .where(eq(chatLorebooks.chatId, chatId))
      .all()
      .map((r) => r.id),
    'chat',
  )
  if (personaLorebookId) add([personaLorebookId], 'persona')
  if (characterIds.length > 0) {
    add(
      db
        .select({ id: characterLorebooks.lorebookId })
        .from(characterLorebooks)
        .where(inArray(characterLorebooks.characterId, characterIds))
        .orderBy(asc(characterLorebooks.position))
        .all()
        .map((r) => r.id),
      'character',
    )
  }
  add(
    db
      .select({ id: lorebooks.id })
      .from(lorebooks)
      .where(eq(lorebooks.isGlobal, true))
      .all()
      .map((r) => r.id),
    'global',
  )
  if (sources.size === 0) return []

  const books = db
    .select()
    .from(lorebooks)
    .where(inArray(lorebooks.id, [...sources.keys()]))
    .all()
  const names = new Map(books.map((b) => [b.id, b.name]))
  return db
    .select()
    .from(lorebookEntries)
    .where(inArray(lorebookEntries.lorebookId, [...sources.keys()]))
    .orderBy(asc(lorebookEntries.lorebookId), asc(lorebookEntries.sort))
    .all()
    .map((e) => ({
      ...lorebookEntryDataSchema.parse(e.data),
      id: e.id,
      lorebookId: e.lorebookId,
      lorebookName: names.get(e.lorebookId) ?? '',
      source: sources.get(e.lorebookId) ?? 'global',
    }))
}

export function loadGenerationContext(chatId: string, opts: { requireConnection: boolean }): GenerationContext {
  const chat = getChatRow(chatId)
  const persona = resolvePersona(chat)
  const group = chat.groupId ? loadGroupDTO(chat.groupId) : null

  let members: PromptCharacter[]
  if (group) {
    const rows = db
      .select()
      .from(characters)
      .where(
        inArray(
          characters.id,
          group.members.map((m) => m.characterId),
        ),
      )
      .all()
    members = group.members
      .map((m) => {
        const row = rows.find((r) => r.id === m.characterId)
        return row ? toPromptCharacter(row, m.muted) : null
      })
      .filter((x): x is PromptCharacter => x !== null)
    if (members.length === 0) throw new HttpError(400, 'EMPTY_GROUP', '这个群聊没有任何成员')
  } else {
    const row = chat.characterId ? db.select().from(characters).where(eq(characters.id, chat.characterId)).get() : null
    if (!row) throw notFound('角色')
    members = [toPromptCharacter(row)]
  }

  let connection: ApiPresetRow | null = null
  try {
    connection = resolveApiPreset(chat.apiPresetId)
  } catch (e) {
    if (opts.requireConnection) throw e
  }

  return {
    chat,
    connection,
    preset: resolvePreset(chat),
    persona,
    members,
    group,
    loreEntries: loadLore(
      chat.id,
      members.map((m) => m.id),
      persona.lorebookId,
    ),
  }
}

/** 把激活路径上的消息转成组装用的历史（失败的消息不发给模型） */
export function toHistory(ctx: GenerationContext, leafId: string | null): HistoryMessage[] {
  const names = new Map(ctx.members.map((m) => [m.id, m.name]))
  return loadPath(leafId)
    .filter((m) => m.status !== 'error')
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      name:
        m.role === 'user'
          ? ctx.persona.name
          : m.role === 'tool'
            ? (m.meta.toolName ?? '工具')
            : ((m.speakerId && names.get(m.speakerId)) ?? m.meta.name ?? ctx.members[0]?.name ?? ''),
      speakerId: m.speakerId,
      ...(m.meta.toolCalls ? { toolCalls: m.meta.toolCalls } : {}),
      ...(m.meta.toolCallId ? { toolCallId: m.meta.toolCallId } : {}),
    }))
}

export interface AssembleOptions {
  type: GenerationType
  speakerId: string
  /** 历史的最后一条（新回复挂在它下面；续写时就是被续写的消息） */
  leafId: string | null
  /** 还没入库的用户消息（预览时用） */
  pending?: { role: MessageRole; content: string }
  toolsEnabled: boolean
}

/** 组装一次 Prompt：扩展前置钩子 → buildPrompt → 扩展后置钩子 */
export function assemble(ctx: GenerationContext, opts: AssembleOptions): PromptPreview & { input: BuildInput } {
  const speaker = ctx.members.find((m) => m.id === opts.speakerId) ?? ctx.members[0]
  if (!speaker) throw new HttpError(400, 'NO_SPEAKER', '找不到发言的角色')
  const history = toHistory(ctx, opts.leafId)
  if (opts.pending) {
    history.push({
      id: 'pending',
      role: opts.pending.role,
      content: opts.pending.content,
      name: ctx.persona.name,
      speakerId: null,
    })
  }

  let input: BuildInput = {
    type: opts.type,
    preset: ctx.preset,
    speaker,
    group: ctx.group
      ? {
          name: ctx.group.name,
          members: ctx.members,
          mode: ctx.group.generationMode,
          scenarioOverride: ctx.group.scenarioOverride,
        }
      : null,
    persona: { name: ctx.persona.name, description: ctx.persona.description },
    history,
    lore: { entries: ctx.loreEntries, settings: getWorldInfoSettings() },
    chat: {
      id: ctx.chat.id,
      leafId: opts.leafId,
      authorNote: ctx.chat.authorNote,
      authorNoteDepth: ctx.chat.authorNoteDepth,
      authorNoteRole: ctx.chat.authorNoteRole,
    },
    toolsEnabled: opts.toolsEnabled,
    now: new Date(),
    macros: collectMacros(ctx.chat.id),
  }
  input = runBeforePrompt(input)

  try {
    const { messages, report } = buildPrompt(input)
    const finalMessages: ChatMessage[] = runAfterPrompt(messages, ctx.chat.id)
    return { messages: finalMessages, report, input }
  } catch (e) {
    if (e instanceof PromptBudgetError) throw new HttpError(400, 'PROMPT_TOO_LONG', e.message)
    throw e
  }
}
