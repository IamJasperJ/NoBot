import {
  castKey,
  foldStage,
  getRuleSystem,
  mergeStateSchemas,
  parseInitVars,
  parseStageMessage,
  parseStateSchema,
  resolveCombatStart,
  schemaInitVars,
} from '@ai-parter/core/stage'
import {
  type AttachmentDTO,
  cardVnSchema,
  EXPRESSIONS,
  type MessageMeta,
  type MessageRole,
  type MessageStatus,
  type PlayPresetData,
  type StateSchema,
} from '@ai-parter/shared'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db, getSetting } from '../db/client'
import { characters, groupMembers, messages } from '../db/schema'
import { backgroundsForChat } from './backgrounds'
import { computeVars, getChatRow, loadPath } from './chats'
import { loadLore, resolvePersona } from './context'
import { getDefault, listPlayPresets } from './playPresets'
import { resolveWho } from './trpg'
import { readSheet } from './trpg-sheet'

export function stageMembers(chatId: string) {
  const chat = getChatRow(chatId)
  if (chat.characterId) {
    const row = db.select().from(characters).where(eq(characters.id, chat.characterId)).get()
    return row ? [row] : []
  }
  if (!chat.groupId) return []
  return (
    db
      .select({ character: characters })
      .from(groupMembers)
      .innerJoin(characters, eq(characters.id, groupMembers.characterId))
      // 回收站里的角色不参与群聊的演员映射（恢复后自动回来）
      .where(and(eq(groupMembers.groupId, chat.groupId), isNull(characters.deletedAt)))
      .orderBy(asc(groupMembers.position))
      .all()
      .map((row) => row.character)
  )
}
/** 完整名字优先，再匹配名字的第一个词，与演员映射保持一致。 */
export function matchStageMember(chatId: string, who: string) {
  const key = castKey(who)
  const members = stageMembers(chatId)
  return (
    members.find((member) => castKey(member.name) === key) ??
    members.find((member) => castKey(member.name.trim().split(/\s+/)[0]!) === key)
  )
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
  const rules = getRuleSystem(data.trpg.ruleSystem)
  const persona = resolvePersona(getChatRow(chatId))
  // 优先级：schema 默认值 < sheet < InitVar < 路径上的 varsPatch / 手动值。
  if (rules) {
    if (persona.sheet) Object.assign(vars, rules.initVars('player', persona.sheet))
    for (const member of stageMembers(chatId)) {
      const sheet = readSheet(member.extensions)
      if (sheet) Object.assign(vars, rules.initVars(member.name, sheet))
    }
  }
  if (!data.state.initVar) return { vars, rules: {} }
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
  const library = backgroundsForChat(chatId)
  const match = bg
    ? (library.find((row) => normalize(row.name) === bg) ??
      library
        .filter((row) => normalize(row.name) && (normalize(row.name).includes(bg) || bg.includes(normalize(row.name))))
        .sort((a, b) => b.name.length - a.name.length)[0])
    : undefined
  stage.scene.backgroundId = match?.id ?? null
  const temporary = getSetting<Record<string, AttachmentDTO>>(`vn-actors:${chatId}`) ?? {}
  for (const actor of stage.cast) {
    actor.characterId = matchStageMember(chatId, actor.key)?.id ?? null
    actor.spriteUrl = temporary[actor.key]?.url
  }
  return stage
}

/** 正文解析是 assistant 变量补丁的唯一来源；续写和编辑都按全文重算。 */
export function applyStageParse(
  chatId: string,
  message: { role: MessageRole; status: MessageStatus; parentId: string | null; meta: MessageMeta },
  content: string,
  random: () => number = Math.random,
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
  const rules = getRuleSystem(data.trpg.ruleSystem)
  const vars = { ...computeVars(path, initialVars(chatId).vars), ...result.varsPatch }
  const previousStarts = message.meta.stage?.ops.filter((op) => op.op === 'combat' && op.action === 'start') ?? []
  let startIndex = 0
  const resolve = (op: (typeof result.stage.ops)[number]) => {
    // 续写会重解析全文，已有且参与者相同的开战操作复用先攻，避免无意重掷。
    const previous = op.op === 'combat' && op.action === 'start' ? previousStarts[startIndex++] : undefined
    if (
      op.op === 'combat' &&
      op.action === 'start' &&
      previous?.op === 'combat' &&
      previous.action === 'start' &&
      previous.order &&
      JSON.stringify(previous.who) === JSON.stringify(op.who)
    )
      return { ...op, order: previous.order }
    const resolved = resolveCombatStart(op, (who) => {
      const actor = resolveWho(chatId, who)
      return rules?.initiative({ name: actor.prefix, sheet: actor.sheet, vars }, random) ?? 0
    })
    if (resolved.op === 'combat' && resolved.action === 'start' && resolved.order) {
      resolved.order = resolved.order.map((entry) => ({
        ...entry,
        characterId: resolveWho(chatId, entry.name).characterId,
      }))
    }
    return resolved
  }
  // beats 与 ops 引用同一次掷骰，前端逐拍播放和后端回放必须看到相同先攻。
  const resolved = new Map(result.stage.ops.map((op) => [op, resolve(op)]))
  result.stage.ops = result.stage.ops.map((op) => resolved.get(op)!)
  for (const beat of result.stage.beats) {
    if (beat.kind === 'stage') beat.ops = beat.ops.map((op) => resolved.get(op) ?? resolve(op))
  }
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
