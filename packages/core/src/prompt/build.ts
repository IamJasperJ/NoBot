import type {
  BuildReport,
  CharacterExtras,
  CharacterFields,
  ChatMessage,
  GenerationType,
  GroupGenerationMode,
  MessageRole,
  PresetData,
  PromptRole,
  ToolCall,
  WorldInfoSettings,
} from '@ai-parter/shared'
import { countTokens, MESSAGE_OVERHEAD_TOKENS } from '../tokenizer'
import { type ScanEntry, scanWorldInfo } from '../worldinfo'
import {
  applyName,
  groupInjections,
  type Injection,
  injectHistory,
  type Piece,
  parseExample,
  postprocess,
  segmentOf,
} from './assembly'
import { applyMacros, type MacroContext } from './macros'

/**
 * Prompt 组装 v2：完全由「生成预设」驱动（纯函数，不读数据库、不发请求）。
 * 预览和真实发送调用的是同一个函数。
 */

/** 图片预算采用统一估算，避免 core 依赖实际文件或模型的视觉分词规则。 */
export const IMAGE_TOKENS = 300

export class PromptBudgetError extends Error {}

export interface PromptCharacter {
  id: string
  name: string
  fields: CharacterFields
  extras: CharacterExtras
  /** 群聊里是否被静音（join 模式下决定是否合并它的卡片） */
  muted?: boolean
}

/** 一条历史消息（激活路径上，从根到叶） */
export interface HistoryMessage {
  id: string
  role: MessageRole
  content: string
  /** 发言人显示名：user 是人设名，assistant 是角色名，tool 是工具名 */
  name: string
  /** assistant 消息的发言角色 id（群聊里区分是谁说的） */
  speakerId: string | null
  /** assistant 消息发起的工具调用 */
  toolCalls?: ToolCall[]
  /** tool 消息对应的调用 */
  toolCallId?: string
  /** 附件 id，由调用方解析成实际图片 */
  images?: string[]
}

export interface BuildInput {
  type: GenerationType
  preset: PresetData
  /** 当前发言的角色 */
  speaker: PromptCharacter
  /** 群聊信息；单人会话为 null */
  group: {
    name: string
    /** 全部成员，按列表顺序 */
    members: PromptCharacter[]
    mode: GroupGenerationMode
    /** 不为空时代替所有成员的场景 */
    scenarioOverride: string
  } | null
  persona: { name: string; description: string }
  /**
   * 激活路径上的历史，从根到叶（调用方已去掉 status=error 的消息）。
   * continue 模式下最后一条就是要续写的那条 assistant 消息。
   */
  history: HistoryMessage[]
  /** 已挂载的全部世界书条目，以及全局激活设置 */
  lore: { entries: ScanEntry[]; settings: WorldInfoSettings }
  chat: {
    id: string
    /** 当前叶子 id，参与随机种子 */
    leafId: string | null
    authorNote: string
    authorNoteDepth: number
    authorNoteRole: PromptRole
  }
  /** 本次请求是否携带工具定义。为 false 时历史里的工具调用要转成普通文本 */
  toolsEnabled: boolean
  /** 从外部传入，保证结果可复现 */
  now: Date
  /** 扩展提供的宏：名字（小写）→ 处理函数，参数是 {{名字::参数}} 里 :: 之后的部分（没有则为空串） */
  macros?: Record<string, (arg: string) => string>
}

/**
 * 组装规则（按顺序）：
 *
 * 【0. 准备】
 *  budget = floor((samplers.contextSize - samplers.maxTokens) * 0.95)。token 计数用 ../tokenizer 的
 *  countTokens(content) + MESSAGE_OVERHEAD_TOKENS（每条消息的固定开销）。
 *  宏上下文：char = speaker.name；user = persona.name；group = 群聊成员名用「、」连接（单人会话为 char）；
 *  lastChatMessage = history 最后一条的内容；seed = `${chat.id}|${chat.leafId ?? ''}`；extra = input.macros；
 *  original（只在角色卡覆盖主提示词 / 历史后指令时可用，等于预设里的原文）；
 *  outlet::名字 = 世界书 outlet 条目内容（见 2）。宏实现见 ./macros.ts（需要扩展它以支持这些新宏）。
 *
 * 【1. 世界书扫描】调用 ../worldinfo 的 scanWorldInfo：
 *  history 取 role 为 user / assistant 的消息（name 作为发言人名）；characterName = speaker.name；
 *  sources = { char_description, char_personality, scenario, persona, char_note（角色备注）, creator_notes }；
 *  budget = min(contextSize * budgetPercent / 100, budgetCap || ∞)；seed 同上；macro = 上面的宏函数。
 *  结果按 position 分组。每个条目内容先套 utility.worldInfoFormat（把 {0} 替换成内容）。
 *  before_char / after_char 的条目分别用 "\n" 拼成一段，供 wi_before / wi_after 条目使用；
 *  before_em / after_em 作为额外的示例对话块（见 3 的 examples）；before_an / after_an 拼在作者注释上下；
 *  at_depth 的条目作为聊天内注入（role、depth 用条目自己的，order 用条目的 order）；
 *  outlet 条目按 outletName 分组，用 "\n" 连接后供 {{outlet::名字}} 宏使用。
 *
 * 【2. 按预设排布】依次处理 preset.prompts（跳过 enabled=false、triggers 非空且不含 type 的）：
 *  - main：内容为预设 content；若 behavior.preferCharPrompt 且角色卡 system_prompt 非空，则用角色卡的
 *    （其中 {{original}} 替换为预设原文）
 *  - post_history：同理，对应 preferCharInstructions 和角色卡 post_history_instructions
 *  - auxiliary、enhance_definitions、自定义条目：预设 content
 *  - char_description：角色卡 description。群聊 join / join_include_muted 模式下合并所有成员的
 *    description（join 模式跳过静音成员，但当前发言者总是包含），每段写成「名字：\n内容」，空的跳过
 *  - char_personality：utility.personalityFormat，把 {{personality}} 替换成性格；性格为空则整段跳过。join 模式同上合并
 *  - scenario：group.scenarioOverride 非空时用它；否则 utility.scenarioFormat 替换 {{scenario}}。join 模式同上合并
 *  - persona：人设描述；为空则跳过
 *  - wi_before / wi_after：对应世界书段落；为空则跳过
 *  - examples：见 3；history：占位，见 4
 *  - 所有文本内容都要做宏替换并 trim；结果为空的片段跳过
 *  - position = in_chat 的条目不放在这里，而是作为聊天内注入（depth、order、role 用条目自己的）
 *
 * 【3. 示例对话】behavior.exampleBehavior = disabled 时不发送。
 *  来源：before_em 世界书块 + 角色卡 mes_example（按 <START> 切块；join 模式下合并所有成员的）+ after_em 世界书块。
 *  每块先发一条 system 消息 utility.newExampleChat（非空时），然后把块里的内容按行解析：
 *  以「{{user}}:」开头的行开始一条 user 消息，以「{{char}}:」（或任一成员名字加冒号）开头的行开始一条 assistant 消息，
 *  后续行接在当前消息里；块开头没有前缀的文字作为一条 system 消息。解析前先做宏替换前的标记识别
 *  （即识别原始文本里的 {{user}}: / {{char}}:），内容再做宏替换。
 *  预算：exampleBehavior = keep 时算入固定部分；gradual 时在历史之后用剩余预算按块逐个加入，放不下就停。
 *
 * 【4. 聊天记录与预算】固定部分 = 第 2 步全部片段 + 聊天内注入 + 第 6 步的结尾片段 + newChat 提示。
 *  固定部分超过 budget 时抛 PromptBudgetError（中文说明超了多少）。
 *  历史先按「单元」分组：带 toolCalls 的 assistant 消息和紧随其后对应的 tool 消息是一个单元，其余每条消息一个单元；
 *  从最新的单元往旧的填，放不下就停（保证工具调用和结果成对保留）。
 *  非空的 newChat 提示（群聊用 newGroupChat）作为一条 system 消息放在历史最前面（只有历史非空时）。
 *  continue 模式且 behavior.continuePrefill 时：最后一条（被续写的）消息不放在历史里，而是放到整个 Prompt 最后（见 6）。
 *
 * 【5. 聊天内注入】需要按深度插入的内容：
 *  - 作者注释（chat.authorNote 非空时）：内容 = before_an 世界书 + 作者注释 + after_an 世界书（"\n" 连接），
 *    深度 chat.authorNoteDepth，角色 chat.authorNoteRole，order 0
 *  - 角色备注 extras.characterNote（非空时）：深度、角色用 extras 的，order 0
 *  - at_depth 世界书条目；position = in_chat 的预设条目
 *  depth = d 表示插在保留下来的历史的倒数第 d 条之前（0 = 历史末尾之后），d 超过历史长度时放在历史最前面。
 *  同一深度内先按 order 升序，再按角色「user → assistant → system」。同深度、同 order、同角色的内容用 "\n" 合并成一条消息。
 *
 * 【6. 结尾】按顺序追加：
 *  - 群聊（group 非空）且 type 不是 impersonate：utility.groupNudge（非空时）作为 system 消息
 *  - type = continue：continuePrefill 时把被续写的消息作为 assistant 消息放在最后（内容原样）；
 *    否则追加 system 消息 utility.continueNudge（{{lastChatMessage}} 为被续写内容）
 *  - type = impersonate：utility.impersonation 作为 system 消息；assistantImpersonationPrefill 非空时再追加一条 assistant 消息
 *  - 其他类型：assistantPrefill 非空时追加一条 assistant 消息
 *
 * 【7. 名字】behavior.namesBehavior：
 *  - content：历史和示例里的 user / assistant 消息内容前加「名字: 」（示例里 user 用人设名、assistant 用 char 名）
 *  - default：只有群聊时这样做
 *  - completion：放到 name 字段，名字只保留 [A-Za-z0-9_-]，截到 64 字符；清理后为空则退回 content 方式
 *  - none：不处理
 *
 * 【8. 工具】toolsEnabled 为 false 时：带 toolCalls 的 assistant 消息去掉 tool_calls，内容后面追加
 *  「[调用工具 名字(参数)]」；tool 消息改成 system 消息「[工具结果 名字] 内容」。
 *  toolsEnabled 为 true 时按 OpenAI 格式输出 tool_calls / tool_call_id。
 *
 * 【9. 后处理】（tool、tool_calls 和带图片的消息不参与相邻合并；single_user 保留图片边界）
 *  - squashSystem：合并相邻的 system 消息（示例对话的 system 除外）
 *  - postProcessing：none 不处理；merge 合并相邻同角色消息（"\n\n" 连接）；
 *    semi_strict 在 merge 基础上，第一条非 system 消息之后出现的 system 改成 user 再合并；
 *    strict 在 semi_strict 基础上，若第一条非 system 消息不是 user，在它前面插入一条 user 消息 "[开始]"；
 *    single_user 全部内容合成一条 user 消息（"\n\n" 连接，丢弃 name 和工具字段）
 *
 * 【报告】report.segments 按最终发送顺序列出每个片段（后处理合并前），label 用中文
 *  （预设条目用条目 name，历史用「历史消息」，世界书注入用「世界书：条目备注」，作者注释、角色备注、结尾提示各自命名）。
 *  totalTokens 是最终 messages 的 token 总和；historyTotal / historyKept 是消息条数；worldInfo 用扫描结果的 report。
 */
export function buildPrompt(input: BuildInput): { messages: ChatMessage[]; report: BuildReport } {
  // 【0】所有外部状态都从参数取得；预算按发送正文和每条消息的固定开销计算。
  const { preset, speaker, group } = input
  const { behavior, utility } = preset
  const budget = Math.floor((preset.samplers.contextSize - preset.samplers.maxTokens) * 0.95)
  const context: MacroContext = {
    char: speaker.name,
    user: input.persona.name,
    group: group ? group.members.map((member) => member.name).join('、') : speaker.name,
    lastChatMessage: input.history.at(-1)?.content ?? '',
    seed: `${input.chat.id}|${input.chat.leafId ?? ''}`,
    now: input.now,
    extra: input.macros,
    outlets: Object.create(null) as Record<string, string>,
  }
  const macro = (text: string, original?: string) =>
    applyMacros(text, {
      ...context,
      original: original === undefined ? undefined : applyMacros(original, context),
    }).trim()
  const cost = (message: ChatMessage) =>
    countTokens(message.content) + MESSAGE_OVERHEAD_TOKENS + (message.images?.length ?? 0) * IMAGE_TOKENS
  const sum = (pieces: Piece[]) => pieces.reduce((total, piece) => total + cost(piece.message), 0)
  const piece = (source: string, label: string, role: ChatMessage['role'], content: string): Piece => ({
    source,
    label,
    message: { role, content },
  })
  const joined = group !== null && group.mode !== 'swap'
  const members = joined
    ? group.members.filter((member) => group.mode === 'join_include_muted' || !member.muted || member.id === speaker.id)
    : [speaker]
  const cardText = (
    get: (member: PromptCharacter) => string,
    transform: (text: string) => string = (text) => text.trim(),
  ) =>
    members
      .map((member) => {
        const content = transform(get(member))
        return content ? (joined ? `${member.name}：\n${content}` : content) : ''
      })
      .filter(Boolean)
      .join('\n')
  const description = cardText((member) => member.fields.description)
  const personality = cardText((member) => member.fields.personality)
  const scenario = group?.scenarioOverride.trim() || cardText((member) => member.fields.scenario)

  // 【1】世界书只扫描一次，扫描报告直接交给预览；包装后的 outlet 供后续宏引用。
  const scanned = scanWorldInfo({
    entries: input.lore.entries,
    settings: input.lore.settings,
    history: input.history.filter((message) => message.role === 'user' || message.role === 'assistant'),
    type: input.type,
    characterName: speaker.name,
    sources: {
      char_description: description,
      char_personality: personality,
      scenario,
      persona: input.persona.description,
      char_note: speaker.extras.characterNote,
      creator_notes: speaker.fields.creator_notes,
    },
    budget: Math.min(
      (preset.samplers.contextSize * input.lore.settings.budgetPercent) / 100,
      input.lore.settings.budgetCap || Number.POSITIVE_INFINITY,
    ),
    seed: context.seed,
    macro: (text) => macro(text),
    countTokens,
  })
  const world = scanned.activated.map(({ entry, content }) => ({
    entry,
    content: macro(utility.worldInfoFormat.replaceAll('{0}', () => content)),
  }))
  const worldText = (position: ScanEntry['position']) =>
    world
      .filter((item) => item.entry.position === position)
      .map((item) => item.content)
      .join('\n')
  for (const { entry, content } of world) {
    if (entry.position !== 'outlet') continue
    const name = entry.outletName.trim()
    const previous = context.outlets![name]
    context.outlets![name] = previous === undefined ? content : `${previous}\n${content}`
  }
  const injections: Injection[] = []
  const addInjection = (
    source: string,
    label: string,
    role: PromptRole,
    text: string,
    depth: number,
    order: number,
  ) => {
    const content = macro(text)
    if (content) injections.push({ piece: { ...piece(source, label, role, content), depth }, depth, order })
  }

  // 【2】列表顺序就是相对顺序，历史与示例保留占位，预算确定后再填充。
  type Slot = { kind: 'piece'; piece: Piece } | { kind: 'history' } | { kind: 'examples' }
  const slots: Slot[] = []
  for (const block of preset.prompts) {
    if (!block.enabled || (block.triggers.length > 0 && !block.triggers.includes(input.type))) continue
    if (block.id === 'history' || block.id === 'examples') {
      slots.push({ kind: block.id })
      continue
    }
    let text = block.content
    let original: string | undefined
    let expanded = false
    switch (block.id) {
      case 'main':
        if (behavior.preferCharPrompt && speaker.fields.system_prompt.trim()) {
          original = text
          text = speaker.fields.system_prompt
        }
        break
      case 'post_history':
        if (behavior.preferCharInstructions && speaker.fields.post_history_instructions.trim()) {
          original = text
          text = speaker.fields.post_history_instructions
        }
        break
      case 'char_description':
        text = cardText((member) => member.fields.description, macro)
        expanded = true
        break
      case 'char_personality':
        text = cardText(
          (member) =>
            member.fields.personality.trim()
              ? utility.personalityFormat.replace(/\{\{personality\}\}/gi, () => member.fields.personality)
              : '',
          macro,
        )
        expanded = true
        break
      case 'scenario':
        text = group?.scenarioOverride.trim()
          ? macro(group.scenarioOverride)
          : cardText(
              (member) =>
                member.fields.scenario.trim()
                  ? utility.scenarioFormat.replace(/\{\{scenario\}\}/gi, () => member.fields.scenario)
                  : '',
              macro,
            )
        expanded = true
        break
      case 'persona':
        text = input.persona.description
        break
      case 'wi_before':
        text = worldText('before_char')
        break
      case 'wi_after':
        text = worldText('after_char')
        break
    }
    const content = expanded ? text : macro(text, original)
    if (!content) continue
    if (block.position === 'in_chat') {
      injections.push({
        piece: { ...piece(block.id, block.name, block.role, content), depth: block.depth },
        depth: block.depth,
        order: block.order,
      })
    } else slots.push({ kind: 'piece', piece: piece(block.id, block.name, block.role, content) })
  }

  // 【3】每块示例独立计费与淘汰，前缀识别发生在正文宏替换之前。
  const exampleBlocks: Piece[][] = []
  if (behavior.exampleBehavior !== 'disabled' && slots.some((slot) => slot.kind === 'examples')) {
    const rawBlocks = [
      ...world.filter((item) => item.entry.position === 'before_em').map((item) => item.content),
      ...members.flatMap((member) => splitExamples(member.fields.mes_example)),
      ...world.filter((item) => item.entry.position === 'after_em').map((item) => item.content),
    ]
    for (const raw of rawBlocks) {
      const messages: Piece[] = []
      const start = macro(utility.newExampleChat)
      if (start) messages.push({ ...piece('examples', '示例对话标记', 'system', start), example: true })
      for (const parsed of parseExample(
        raw,
        input.persona.name,
        speaker.name,
        group?.members.map((m) => m.name) ?? [],
      )) {
        const content = macro(parsed.content)
        if (!content) continue
        const name = parsed.role === 'user' ? input.persona.name : speaker.name
        messages.push({
          ...piece('examples', '示例对话', parsed.role, content),
          message: applyName({ role: parsed.role, content }, name, behavior, group !== null),
          example: true,
        })
      }
      if (messages.length) exampleBlocks.push(messages)
    }
  }

  // 【5】先收集并合并注入，计入固定预算；选完历史后再把深度映射到实际位置。
  if (input.chat.authorNote.trim()) {
    addInjection(
      'author_note',
      '作者注释',
      input.chat.authorNoteRole,
      [worldText('before_an'), input.chat.authorNote, worldText('after_an')].filter(Boolean).join('\n'),
      input.chat.authorNoteDepth,
      0,
    )
  }
  addInjection(
    'character_note',
    '角色备注',
    speaker.extras.characterNoteRole,
    speaker.extras.characterNote,
    speaker.extras.characterNoteDepth,
    0,
  )
  for (const { entry, content } of world) {
    if (entry.position === 'at_depth') {
      addInjection(
        'world_info',
        `世界书：${entry.comment || entry.keys[0] || '无标题'}`,
        entry.role,
        content,
        entry.depth,
        entry.order,
      )
    }
  }
  const groupedInjections = groupInjections(injections)

  // 【7】【8】历史的名字和工具先转换，预算才包含真正发送的文本。
  // 按图片出现位置计数，同一消息内也只保留靠后的图片，重复 id 仍分别计入限制。
  let remainingImages = preset.samplers.inlineImages ? preset.samplers.imageLimit || Number.POSITIVE_INFINITY : 0
  const imageCounts = new Map<HistoryMessage, number>()
  for (const message of [...input.history].reverse()) {
    const count = Math.min(message.images?.length ?? 0, remainingImages)
    imageCounts.set(message, count)
    remainingImages -= count
  }
  const historyPiece = (message: HistoryMessage, continuation = false): Piece => {
    // 历史消息也要做宏替换（开场白里常有 {{user}}）；续写预填充保留原文。
    // 角色消息里的 {{char}} 指说这句话的角色（群聊里可能不是当前发言者）
    const content = continuation
      ? message.content
      : applyMacros(message.content, {
          ...context,
          char: message.role === 'assistant' && message.name ? message.name : context.char,
        })
    let output: ChatMessage = { role: message.role, content }
    if (input.toolsEnabled) {
      if (message.toolCalls?.length)
        output.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }))
      if (message.toolCallId !== undefined) output.tool_call_id = message.toolCallId
    } else {
      if (message.toolCalls?.length) {
        output.content = [
          output.content,
          ...message.toolCalls.map((call) => `[调用工具 ${call.name}(${call.arguments})]`),
        ]
          .filter(Boolean)
          .join('\n')
      }
      if (message.role === 'tool') output = { role: 'system', content: `[工具结果 ${message.name}] ${message.content}` }
    }
    const images = message.images ?? []
    const kept = imageCounts.get(message) ?? 0
    if (kept) output.images = images.slice(images.length - kept)
    output.content = [output.content, ...Array<string>(images.length - kept).fill('[图片]')].filter(Boolean).join('\n')
    if (!continuation) output = applyName(output, message.name, behavior, group !== null)
    return {
      source: 'history',
      label: '历史消息',
      messageId: message.id,
      message: output,
      imageBoundary: Boolean(message.images?.length),
      protected: message.role === 'tool' || Boolean(message.toolCalls?.length) || Boolean(message.images?.length),
    }
  }

  // 【6】结尾片段也属于固定部分；续写原文保留空白，不再作宏替换或名字前缀处理。
  const ending: Piece[] = []
  const appendEnding = (source: string, label: string, role: PromptRole, text: string) => {
    const content = macro(text)
    if (content) ending.push(piece(source, label, role, content))
  }
  if (group && input.type !== 'impersonate') appendEnding('nudge', '群聊提示', 'system', utility.groupNudge)
  const continuation = input.type === 'continue' && behavior.continuePrefill ? input.history.at(-1) : undefined
  if (input.type === 'continue') {
    if (continuation) {
      const tail = historyPiece(continuation, true)
      tail.message.role = 'assistant'
      tail.label = '续写预填充'
      ending.push(tail)
    } else if (!behavior.continuePrefill) appendEnding('nudge', '续写提示', 'system', utility.continueNudge)
  } else if (input.type === 'impersonate') {
    appendEnding('nudge', '代写提示', 'system', utility.impersonation)
    appendEnding('prefill', '代写预填充', 'assistant', behavior.assistantImpersonationPrefill)
  } else appendEnding('prefill', '回复预填充', 'assistant', behavior.assistantPrefill)

  // 【4】工具调用与紧随的对应结果组成不可拆分单元，从最新单元开始连续保留。
  const hasHistory = slots.some((slot) => slot.kind === 'history')
  const rawHistory = hasHistory ? (continuation ? input.history.slice(0, -1) : input.history) : []
  const units: Piece[][] = []
  for (let i = 0; i < rawHistory.length; i++) {
    const message = rawHistory[i]!
    const unit = [historyPiece(message)]
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const calls = new Set(message.toolCalls.map((call) => call.id))
      while (i + 1 < rawHistory.length) {
        const next = rawHistory[i + 1]!
        if (next.role !== 'tool' || !next.toolCallId || !calls.has(next.toolCallId)) break
        unit.push(historyPiece(next))
        i++
      }
    }
    units.push(unit)
  }
  const newChat = macro(group ? utility.newGroupChat : utility.newChat)
  const start =
    newChat && rawHistory.length ? [piece('new_chat', group ? '新群聊提示' : '新对话提示', 'system', newChat)] : []
  const fixed = slots.flatMap((slot) => (slot.kind === 'piece' ? [slot.piece] : []))
  const keptExamples = behavior.exampleBehavior === 'keep' ? exampleBlocks.flat() : []
  let used = sum([...fixed, ...groupedInjections.map((item) => item.piece), ...ending, ...start, ...keptExamples])
  if (used > budget) throw new PromptBudgetError(`固定提示词超出预算 ${used - budget} token（预算 ${budget} token）`)
  const keptHistory: Piece[] = []
  for (let i = units.length - 1; i >= 0; i--) {
    const unit = units[i]!
    const tokens = sum(unit)
    if (used + tokens > budget) break
    used += tokens
    keptHistory.unshift(...unit)
  }
  // 完全没留下历史时不发送开场提示，把预留预算还给渐进示例。
  if (keptHistory.length === 0) used -= sum(start)
  if (behavior.exampleBehavior === 'gradual') {
    for (const block of exampleBlocks) {
      const tokens = sum(block)
      if (used + tokens > budget) break
      used += tokens
      keptExamples.push(...block)
    }
  }
  const history = [...(keptHistory.length ? start : []), ...injectHistory(keptHistory, groupedInjections)]
  const ordered = slots.flatMap((slot) =>
    slot.kind === 'piece' ? [slot.piece] : slot.kind === 'history' ? history : keptExamples,
  )
  // 没有历史占位时深度注入仍是固定提示，统一放在相对条目后、结尾前。
  if (!hasHistory) ordered.push(...groupedInjections.map((item) => item.piece))
  ordered.push(...ending)

  // 【9】【报告】报告保留合并前的片段，最终 token 总数按后处理后的 messages 重新计算。
  const messages = postprocess(ordered, behavior)
  return {
    messages,
    report: {
      segments: ordered.map((item) => segmentOf(item, cost(item.message))),
      totalTokens: messages.reduce((total, message) => total + cost(message), 0),
      budget,
      historyTotal: input.history.length,
      historyKept: keptHistory.length + (continuation ? 1 : 0),
      worldInfo: scanned.report,
    },
  }
}

/** 按 <START> 切分示例对话（保留给其他模块复用） */
export function splitExamples(mesExample: string): string[] {
  return mesExample
    .split(/<START>/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}
