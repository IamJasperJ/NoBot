import {
  castKey,
  foldStage,
  mergeStateSchemas,
  parseInitVars,
  parseStageMessage,
  parseStateSchema,
  schemaInitVars,
} from '@ai-parter/core/stage'
import {
  cardVnSchema,
  EXPRESSIONS,
  type MessageMeta,
  type MessageRole,
  type MessageStatus,
  type PlayPresetData,
  type StateSchema,
} from '@ai-parter/shared'
import { asc, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { backgrounds, characters, groupMembers, messages } from '../db/schema'
import { computeVars, getChatRow, loadPath } from './chats'
import { loadLore, resolvePersona } from './context'
import { getDefault, listPlayPresets } from './playPresets'

export function stageMembers(chatId: string) {
  const chat = getChatRow(chatId)
  if (chat.characterId) {
    const row = db.select().from(characters).where(eq(characters.id, chat.characterId)).get()
    return row ? [row] : []
  }
  if (!chat.groupId) return []
  return db
    .select({ character: characters })
    .from(groupMembers)
    .innerJoin(characters, eq(characters.id, groupMembers.characterId))
    .where(eq(groupMembers.groupId, chat.groupId))
    .orderBy(asc(groupMembers.position))
    .all()
    .map((row) => row.character)
}
const cardConfig = (extensions: Record<string, unknown>) => cardVnSchema.safeParse(extensions.ai_parter_vn).data

export function resolvePlayPreset(chatId: string) {
  const chat = getChatRow(chatId)
  const presets = listPlayPresets()
  const explicit = presets.find((preset) => preset.id === chat.playPresetId)
  if (explicit) return { id: explicit.id, data: explicit.data }
  const name = stageMembers(chatId)
    .map((member) => cardConfig(member.extensions)?.preset)
    .find((value) => !!value)
  const preset = presets.find((preset) => preset.name === name) ?? getDefault()
  return { id: preset.id, data: preset.data }
}

export function resolveStateSchema(chatId: string, preset: PlayPresetData): StateSchema {
  const base = parseStateSchema(preset.state.schema).schema
  let card: StateSchema = {}
  let hasCard = false
  for (const member of stageMembers(chatId)) {
    const text = cardConfig(member.extensions)?.schema
    if (!text?.trim()) continue
    hasCard = true
    card = mergeStateSchemas(card, parseStateSchema(text).schema)
  }
  return preset.state.schemaSource === 'preset'
    ? base
    : preset.state.schemaSource === 'card'
      ? hasCard
        ? card
        : base
      : mergeStateSchemas(card, base)
}

export function initialVars(chatId: string) {
  const { data } = resolvePlayPreset(chatId)
  if (!data.directives.enabled) return { vars: {}, rules: {} }
  const vars = schemaInitVars(resolveStateSchema(chatId, data))
  if (!data.state.initVar) return { vars, rules: {} }
  const persona = resolvePersona(getChatRow(chatId))
  const init = parseInitVars(
    loadLore(
      chatId,
      stageMembers(chatId).map((member) => member.id),
      persona.lorebookId,
    ),
  )
  return { vars: { ...vars, ...init.vars }, rules: init.rules }
}

export function computeStage(chatId: string, path: { meta: MessageMeta }[]) {
  if (!resolvePlayPreset(chatId).data.directives.enabled) return null
  const stage = foldStage(path.map((message) => message.meta.stage?.ops ?? []))
  const normalize = (name: string) => name.trim().toLowerCase()
  const bg = normalize(stage.scene.bg ?? '')
  const library = db.select().from(backgrounds).all()
  const match = bg
    ? (library.find((row) => normalize(row.name) === bg) ??
      library
        .filter((row) => normalize(row.name) && (normalize(row.name).includes(bg) || bg.includes(normalize(row.name))))
        .sort((a, b) => b.name.length - a.name.length)[0])
    : undefined
  stage.scene.backgroundId = match?.id ?? null
  const members = stageMembers(chatId)
  for (const actor of stage.cast) {
    actor.characterId =
      (
        members.find((member) => castKey(member.name) === actor.key) ??
        members.find((member) => castKey(member.name.trim().split(/\s+/)[0]!) === actor.key)
      )?.id ?? null
  }
  return stage
}

/** 正文解析是 assistant 变量补丁的唯一来源；续写和编辑都按全文重算。 */
export function applyStageParse(
  chatId: string,
  message: { role: MessageRole; status: MessageStatus; parentId: string | null; meta: MessageMeta },
  content: string,
): MessageMeta {
  const meta = { ...message.meta }
  if (message.role !== 'assistant') return meta
  delete meta.stage
  delete meta.varsPatch
  const { data } = resolvePlayPreset(chatId)
  if (!data.directives.enabled || message.status === 'error' || !content.trim()) return meta
  const path = loadPath(message.parentId)
  const stage = computeStage(chatId, path)
  const result = parseStageMessage(content, {
    knownNames: [
      ...new Set([
        ...stageMembers(chatId).map((member) => member.name),
        ...(stage?.cast.map((actor) => actor.name) ?? []),
      ]),
    ],
    narratorNames: [data.trpg.gmName],
    vars: computeVars(path, initialVars(chatId).vars),
    inline: data.state.inline,
    mvu: data.state.mvu,
    expressions: [...EXPRESSIONS, ...data.sprites.customExpressions],
    narrationSplit: data.dialog.narrationSplit,
  })
  meta.stage = result.stage
  if (result.varsPatch !== null) meta.varsPatch = result.varsPatch
  return meta
}

/**
 * 补解析：激活路径上还没有 meta.stage 的角色回复（开场白、开启指令之前的旧消息）按从旧到新的顺序解析一遍并存下来。
 * 必须按顺序，因为每条的变量计算依赖前面的结果。没开指令时什么都不做；解析过的消息不会重复解析。
 */
export function backfillStage(chatId: string) {
  if (!resolvePlayPreset(chatId).data.directives.enabled) return
  const leaf = getChatRow(chatId).activeLeafId
  const missing = loadPath(leaf).filter(
    (m) => m.role === 'assistant' && m.status === 'done' && !m.meta.stage && m.content.trim(),
  )
  for (const message of missing) {
    const meta = applyStageParse(chatId, message, message.content)
    db.update(messages).set({ meta }).where(eq(messages.id, message.id)).run()
  }
}
