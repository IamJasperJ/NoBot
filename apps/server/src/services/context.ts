import {
  type BuildInput,
  buildPrompt,
  type HistoryMessage,
  PromptBudgetError,
  type PromptCharacter,
  type ScanEntry,
} from '@nobot/core'
import {
  describeCheck,
  renderDirectiveInstructions,
  renderDirectiveReminder,
  stateStageName,
  toDisplayText,
} from '@nobot/core/stage'
import {
  type ChatMessage,
  type CheckResult,
  EXPRESSIONS,
  type GenerationType,
  type GroupDTO,
  lorebookEntryDataSchema,
  type MessageRole,
  type PresetData,
  type PromptPreview,
} from '@nobot/shared'
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
} from '../db/schema'
import { HttpError, notFound, promptBudgetMessage } from '../errors'
import { collectMacros, runAfterPrompt, runBeforePrompt } from '../extensions/registry'
import { t } from '../i18n'
import { enabledToolNames } from '../tools'
import { listAudioTracks } from './audio-library'
import { backgroundsForChat } from './backgrounds'
import { replaceImageAttachments } from './caption'
import { computeVars, getChatRow, loadGroupDTO, loadPath } from './chats'
import { matchLoreVectors } from './lore-vectors'
import { resolveProfile } from './profiles'
import { getWorldInfoSettings, SETTING_KEYS } from './settings'
import { listSprites } from './sprites'
import { computeStage, initialVars, resolvePlayPreset, resolveStateSchema } from './stage'
import { chatRules, describeParty } from './trpg'
import { readSheet } from './trpg-sheet'

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
  persona: { id: string | null; name: string; description: string; lorebookId: string | null }
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
      sheet: readSheet(row.extensions),
      talkativeness: row.talkativeness,
      characterNote: row.characterNote,
      characterNoteDepth: row.characterNoteDepth,
      characterNoteRole: row.characterNoteRole,
      defaultPersonaId: row.defaultPersonaId,
      defaultBackgroundId: row.defaultBackgroundId,
    },
  }
}

export function resolvePersona(chat: ChatRow) {
  const id = chat.personaId ?? getSetting<string>(SETTING_KEYS.defaultPersonaId)
  const row = id ? db.select().from(personas).where(eq(personas.id, id)).get() : undefined
  return row
    ? { id: row.id, name: row.name, description: row.description, lorebookId: row.lorebookId, sheet: row.sheet }
    : { id: null, name: t('旅人'), description: '', lorebookId: null, sheet: null }
}

/**
 * 收集挂载的世界书条目。同一本书挂在多处时按优先级只算一次：会话 > 人设 > 角色 > 全局。
 */
export function loadLore(chatId: string, characterIds: string[], personaLorebookId: string | null): ScanEntry[] {
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
    if (members.length === 0) throw new HttpError(400, 'EMPTY_GROUP', t('这个群聊没有任何成员'))
  } else {
    const row = chat.characterId ? db.select().from(characters).where(eq(characters.id, chat.characterId)).get() : null
    if (!row) throw notFound(t('角色'))
    members = [toPromptCharacter(row)]
  }

  const resolved = resolveProfile(chat, opts.requireConnection)

  return {
    chat,
    connection: resolved.connection,
    preset: resolved.preset,
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
export function toHistory(ctx: GenerationContext, leafId: string | null, plainHistory = false): HistoryMessage[] {
  const names = new Map(ctx.members.map((m) => [m.id, m.name]))
  const preset = resolvePlayPreset(ctx.chat.id).data
  const path = loadPath(leafId)
  const knownNames = [
    ...new Set([
      ...ctx.members.map((m) => m.name),
      ...(computeStage(ctx.chat.id, path)?.cast.map((actor) => actor.name) ?? []),
    ]),
  ]
  const assistants = path.filter((m) => m.role === 'assistant' && m.status !== 'error')
  const keep = new Set(
    preset.directives.keepInHistory
      ? (preset.directives.keepRecent > 0 ? assistants.slice(-preset.directives.keepRecent) : assistants).map(
          (m) => m.id,
        )
      : [],
  )
  return path
    .filter(
      (m) =>
        m.status !== 'error' &&
        m.meta.excluded !== true &&
        !(m.role !== 'user' && m.role !== 'tool' && m.meta.imageGen?.hidden === true) &&
        // tool 消息必须保留：它和上一条的 tool_calls 成对出现，丢掉会让模型以为工具没执行而反复调用
        !(
          m.role !== 'user' &&
          m.role !== 'tool' &&
          !m.meta.images?.length &&
          (m.meta.imageGen?.status === 'pending' || m.meta.imageGen?.status === 'error')
        ),
    )
    .map((m) => ({
      id: m.id,
      role: m.role,
      content:
        (!m.content && m.meta.imageGen?.caption
          ? m.meta.imageGen.caption
          : !m.content && m.role !== 'user' && m.role !== 'tool' && (m.meta.imageGen || m.meta.images?.length)
            ? `(Sent an image${m.meta.imageGen?.prompt ? `: ${m.meta.imageGen.prompt}` : ''})`
            : (plainHistory || (preset.directives.enabled && !keep.has(m.id))) && m.role === 'assistant'
              ? toDisplayText(m.content, { knownNames, narratorNames: [preset.trpg.gmName], speaker: 'plain' })
              : m.content) + (m.role === 'user' && m.meta.check ? `\n${describeCheck(m.meta.check)}` : ''),
      name:
        m.role === 'user'
          ? ctx.persona.name
          : m.role === 'tool'
            ? (m.meta.toolName ?? 'tool')
            : ((m.speakerId && names.get(m.speakerId)) ?? m.meta.name ?? ctx.members[0]?.name ?? ''),
      speakerId: m.speakerId,
      ...(m.role === 'user' && m.meta.images?.length ? { images: m.meta.images.map((image) => image.id) } : {}),
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
  pending?: { role: MessageRole; content: string; check?: CheckResult }
  /** 静默任务不遵循聊天正文的舞台输出格式。 */
  vectorMatches?: readonly string[]
  quiet?: boolean
  /** 图片等纯文本辅助任务不需要保留历史舞台协议。 */
  plainHistory?: boolean
  /** 兼容无工具的静默生成；实际启用名单在此按会话统一解析。 */
  toolsEnabled?: boolean
  enabledTools?: string[]
}

/** 组装一次 Prompt：扩展前置钩子 → buildPrompt → 扩展后置钩子 */
export function assemble(ctx: GenerationContext, opts: AssembleOptions): PromptPreview & { input: BuildInput } {
  const speaker = ctx.members.find((m) => m.id === opts.speakerId) ?? ctx.members[0]
  if (!speaker) throw new HttpError(400, 'NO_SPEAKER', t('找不到发言的角色'))
  const history = replaceImageAttachments(toHistory(ctx, opts.leafId, opts.plainHistory), ctx.connection)
  if (opts.pending) {
    history.push({
      id: 'pending',
      role: opts.pending.role,
      content: opts.pending.check
        ? `${opts.pending.content}\n${describeCheck(opts.pending.check)}`
        : opts.pending.content,
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
    lore: {
      entries: ctx.loreEntries,
      settings: getWorldInfoSettings(),
      vectorMatches: opts.vectorMatches,
      activationHistory: loadPath(opts.leafId)
        .filter((message) => message.status !== 'error')
        .map((message) => ({ activated: message.meta.lore?.activated }))
        .concat(opts.pending ? [{ activated: undefined }] : []),
    },
    chat: {
      id: ctx.chat.id,
      leafId: opts.leafId,
      authorNote: ctx.chat.authorNote,
      authorNoteDepth: ctx.chat.authorNoteDepth,
      authorNoteRole: ctx.chat.authorNoteRole,
    },
    enabledTools:
      opts.enabledTools ??
      (opts.toolsEnabled === false || opts.type === 'impersonate'
        ? []
        : enabledToolNames(ctx.chat.id, ctx.preset.samplers)),
    now: new Date(),
    macros: collectMacros(ctx.chat.id),
  }
  const play = resolvePlayPreset(ctx.chat.id).data
  const path = loadPath(opts.leafId)
  const init = initialVars(ctx.chat.id)
  const vars = computeVars(path, init.vars)
  const schema = resolveStateSchema(ctx.chat.id, play)
  input.stages = Object.fromEntries(
    Object.entries(schema).map(([key, field]) => [key, stateStageName(field.stages, vars[key])]),
  )
  if (play.directives.enabled && play.interaction.stageLore) {
    input.lore.scanText = Object.entries(input.stages)
      .filter(([, name]) => name)
      .map(([key, name]) => `${key}_stage: ${name}`)
      .join('\n')
  }
  if (play.directives.enabled && opts.type !== 'impersonate' && !opts.quiet) {
    const stage = computeStage(ctx.chat.id, path)
    const audioEnabled = getSetting<Record<string, boolean>>(SETTING_KEYS.extensionsEnabled)?.audio === true
    const audioSettings = getSetting<Record<string, unknown>>(SETTING_KEYS.extensionSettings('audio'))
    const tracks = audioEnabled && audioSettings?.listInPrompt !== false ? listAudioTracks() : []
    const instructionInput = {
      ...play.directives,
      kinds: play.directives.kinds.filter((kind) => kind !== 'audio' || audioEnabled),
      bgm: tracks.filter((track) => track.kind === 'bgm').map((track) => track.name),
      sfx: tracks.filter((track) => track.kind === 'sfx').map((track) => track.name),
      cast: [
        ...new Set([...ctx.members.map((member) => member.name), ...(stage?.cast.map((actor) => actor.name) ?? [])]),
      ],
      expressions: [...EXPRESSIONS, ...play.sprites.customExpressions],
      outfits: Object.fromEntries(
        ctx.members.map((member) => [
          member.name,
          [
            ...new Set(
              listSprites(member.id)
                .map((sprite) => sprite.outfit)
                .filter(Boolean),
            ),
          ],
        ]),
      ),
      backgrounds: backgroundsForChat(ctx.chat.id).map((row) => row.name),
      schema,
      rules: init.rules,
      vars,
      valuesInPrompt: play.state.valuesInPrompt,
    }
    input.injections = []
    if (play.directives.inject)
      input.injections.push({
        id: 'stage',
        label: t('舞台指令'),
        labelCode: 'stage',
        role: 'system',
        content: [
          renderDirectiveInstructions(instructionInput),
          ...(play.directives.kinds.includes('combat') || chatRules(ctx.chat.id)
            ? [
                'For random outcomes call roll_dice; for ability, skill, or saving throw checks call ability_check. Never invent dice results. Prefix choice checks with [Perception DC 12] using English skill names (legacy Chinese skill names are also accepted).',
                describeParty(ctx.chat.id, vars),
              ]
            : []),
        ]
          .filter(Boolean)
          .join('\n\n'),
        position: play.directives.position,
        depth: play.directives.position === 'author_note' ? ctx.chat.authorNoteDepth : play.directives.depth,
      })
    if (play.directives.reminder)
      input.injections.push({
        id: 'stage_reminder',
        label: t('舞台指令提醒'),
        labelCode: 'stage_reminder',
        position: 'end',
        role: play.directives.reminderRole,
        content: renderDirectiveReminder({ ...instructionInput, reminderTemplate: play.directives.reminderTemplate }),
      })
  }
  input = runBeforePrompt(input)

  try {
    const { messages, report } = buildPrompt(input)
    report.excludedCount = loadPath(opts.leafId).filter((m) => m.meta.excluded === true).length
    const finalMessages: ChatMessage[] = runAfterPrompt(messages, ctx.chat.id)
    return { messages: finalMessages, report, input }
  } catch (e) {
    if (e instanceof PromptBudgetError) throw new HttpError(400, 'PROMPT_TOO_LONG', promptBudgetMessage(e.message))
    throw e
  }
}

/** 网络与缓存留在服务层，向量命中后仍走同一套纯扫描和预算。 */
export async function assembleWithVectors(ctx: GenerationContext, opts: AssembleOptions) {
  const settings = getWorldInfoSettings()
  const history = toHistory(ctx, opts.leafId, opts.plainHistory).filter(
    (message) => message.role === 'user' || message.role === 'assistant',
  )
  if (opts.pending)
    history.push({
      id: 'pending',
      role: opts.pending.role,
      content: opts.pending.check
        ? `${opts.pending.content}\n${describeCheck(opts.pending.check)}`
        : opts.pending.content,
      name: ctx.persona.name,
      speakerId: null,
    })
  const vectorMatches = await matchLoreVectors(ctx.loreEntries, history, settings)
  return assemble(ctx, { ...opts, vectorMatches })
}
