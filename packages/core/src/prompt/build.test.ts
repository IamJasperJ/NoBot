import { describe, expect, test } from 'bun:test'
import {
  characterExtrasSchema,
  characterFieldsSchema,
  lorebookEntryDataSchema,
  presetDataSchema,
  promptBlockSchema,
  worldInfoSettingsSchema,
} from '@ai-parter/shared'
import { countTokens, MESSAGE_OVERHEAD_TOKENS } from '../tokenizer'
import type { ScanEntry } from '../worldinfo'
import {
  type BuildInput,
  buildPrompt,
  filterToolHistory,
  type HistoryMessage,
  PromptBudgetError,
  splitExamples,
} from './build'

function input(): BuildInput {
  return {
    type: 'normal',
    preset: presetDataSchema.parse({}),
    speaker: {
      id: 'char',
      name: '小明',
      fields: characterFieldsSchema.parse({ name: '小明', description: '角色背景' }),
      extras: characterExtrasSchema.parse({}),
    },
    group: null,
    persona: { name: '小红', description: '用户背景' },
    history: [history('u', 'user', '你好'), history('a', 'assistant', '您好')],
    lore: { entries: [], settings: worldInfoSettingsSchema.parse({}) },
    chat: { id: 'chat', leafId: 'a', authorNote: '', authorNoteDepth: 4, authorNoteRole: 'system' },
    enabledTools: [],
    now: new Date('2026-01-02T03:04:00Z'),
  }
}
function history(id: string, role: HistoryMessage['role'], content: string): HistoryMessage {
  return { id, role, content, name: role === 'user' ? '小红' : '小明', speakerId: role === 'assistant' ? 'char' : null }
}
function minimal(): BuildInput {
  const value = input()
  value.preset.prompts = [promptBlockSchema.parse({ id: 'history', name: '聊天记录' })]
  value.preset.behavior.postProcessing = 'none'
  value.preset.utility.newChat = ''
  return value
}
function lore(id: string, data: Parameters<typeof lorebookEntryDataSchema.parse>[0]): ScanEntry {
  return { ...lorebookEntryDataSchema.parse(data), id, lorebookId: 'book', lorebookName: '世界', source: 'chat' }
}
function contents(value: BuildInput): string[] {
  return buildPrompt(value).messages.map((message) => message.content)
}
function custom(id: string, data: Record<string, unknown> = {}) {
  return promptBlockSchema.parse({ id, name: id, content: id, ...data })
}
function tokenCost(text: string): number {
  return countTokens(text) + MESSAGE_OVERHEAD_TOKENS
}
function setBudget(value: BuildInput, budget: number) {
  value.preset.samplers.contextSize = 512
  value.preset.samplers.maxTokens = 512 - Math.ceil(budget / 0.95)
  expect(Math.floor((512 - value.preset.samplers.maxTokens) * 0.95)).toBe(budget)
}

describe('预设与宏覆盖', () => {
  test('默认预设角色顺序、主提示词宏、system 合并与报告', () => {
    const value = input()
    const result = buildPrompt(value)
    expect(result.messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant'])
    expect(result.messages[0]!.content).toContain('你正在和小红')
    expect(result.messages[0]!.content).toContain('你扮演小明')
    expect(result.messages[0]!.content).toContain('用户背景\n\n角色背景')
    expect(result.report.segments.map((segment) => segment.source)).toEqual([
      'main',
      'persona',
      'char_description',
      'new_chat',
      'history',
      'history',
    ])
    expect(result.report.totalTokens).toBe(
      result.messages.reduce((sum, message) => sum + tokenCost(message.content), 0),
    )
    expect(result.report.historyTotal).toBe(2)
    expect(result.report.historyKept).toBe(2)
  })
  test('角色覆盖、original 内的宏以及关闭覆盖', () => {
    const value = minimal()
    value.preset.prompts = [
      custom('main', { content: '原文{{user}}' }),
      custom('post_history', { content: '后文{{char}}' }),
    ]
    value.speaker.fields.system_prompt = '覆盖{{original}}'
    value.speaker.fields.post_history_instructions = '后覆盖{{ORIGINAL}}'
    expect(contents(value)).toEqual(['覆盖原文小红', '后覆盖后文小明'])
    value.preset.behavior.preferCharPrompt = false
    value.preset.behavior.preferCharInstructions = false
    expect(contents(value)).toEqual(['原文小红', '后文小明'])
  })
  test('禁用、触发类型与自定义相对顺序', () => {
    const value = minimal()
    value.preset.prompts = [
      custom('甲'),
      custom('禁用', { enabled: false }),
      custom('乙', { triggers: ['continue'] }),
      custom('丙'),
    ]
    expect(contents(value)).toEqual(['甲', '丙'])
    value.type = 'continue'
    value.preset.utility.continueNudge = ''
    expect(contents(value)).toEqual(['甲', '乙', '丙'])
    value.preset.prompts.reverse()
    expect(contents(value)).toEqual(['丙', '乙', '甲'])
  })
  test('历史占位调整后与结尾条目保持预设顺序', () => {
    const value = minimal()
    value.preset.prompts = [custom('前'), ...value.preset.prompts, custom('后')]
    expect(contents(value)).toEqual(['前', '你好', '您好', '后'])
  })
})

describe('深度注入与世界书', () => {
  test('深度 0、1、越界，同深度先 order 后角色，同键合并', () => {
    const value = minimal()
    value.preset.prompts.push(
      custom('尾', { position: 'in_chat', depth: 0 }),
      custom('前', { position: 'in_chat', depth: 999 }),
      custom('系统', { position: 'in_chat', depth: 1, order: 2 }),
      custom('助手', { position: 'in_chat', depth: 1, order: 2, role: 'assistant' }),
      custom('用户一', { position: 'in_chat', depth: 1, order: 2, role: 'user' }),
      custom('用户二', { position: 'in_chat', depth: 1, order: 2, role: 'user' }),
      custom('优先', { position: 'in_chat', depth: 1, order: 1 }),
    )
    expect(contents(value)).toEqual(['前', '你好', '优先', '用户一\n用户二', '助手', '系统', '您好', '尾'])
    const report = buildPrompt(value).report
    expect(report.segments.find((segment) => segment.content === '尾')?.depth).toBe(0)
  })
  test('作者注释包裹、角色备注和 at_depth 自带角色', () => {
    const value = minimal()
    value.chat.authorNote = '作者'
    value.chat.authorNoteDepth = 1
    value.chat.authorNoteRole = 'assistant'
    value.speaker.extras.characterNote = '角色备注'
    value.speaker.extras.characterNoteDepth = 0
    value.speaker.extras.characterNoteRole = 'user'
    value.lore.entries = [
      lore('前', { constant: true, content: '注前', position: 'before_an' }),
      lore('后', { constant: true, content: '注后', position: 'after_an' }),
      lore('深', {
        constant: true,
        content: '深度',
        position: 'at_depth',
        depth: 0,
        role: 'assistant',
        comment: '标题',
      }),
    ]
    const result = buildPrompt(value)
    expect(result.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', '你好'],
      ['assistant', '注前\n作者\n注后'],
      ['assistant', '您好'],
      ['user', '角色备注'],
      ['assistant', '深度'],
    ])
    expect(result.report.segments.at(-1)?.label).toBe('世界书：标题')
  })
  test('世界书角色前后、格式、outlet、扫描报告与触发过滤', () => {
    const value = minimal()
    value.preset.prompts = [custom('wi_before'), custom('char_description'), custom('wi_after')]
    value.speaker.fields.description = '{{outlet:: 插槽 }}'
    value.preset.utility.worldInfoFormat = '<{0}>'
    value.lore.entries = [
      lore('前', { constant: true, content: '前{{char}}' }),
      lore('后', { constant: true, content: '后', position: 'after_char' }),
      lore('槽一', { constant: true, content: '一', position: 'outlet', outletName: '插槽' }),
      lore('槽二', { constant: true, content: '二', position: 'outlet', outletName: '插槽' }),
      lore('过滤', { constant: true, content: '不发', triggers: ['continue'] }),
    ]
    expect(contents(value)).toEqual(['<前小明>', '<一>\n<二>', '<后>'])
    expect(buildPrompt(value).report.worldInfo).toHaveLength(4)
    expect(buildPrompt(value).report.worldInfo.every((entry) => entry.activated)).toBe(true)
  })
  test('扫描只使用用户助手历史并提供额外匹配来源', () => {
    const value = minimal()
    value.history = [history('s', 'system', '系统专词'), history('t', 'tool', '工具专词')]
    value.speaker.fields.creator_notes = '创作者关键词'
    value.lore.entries = [
      lore('不应激活', { keys: ['系统专词', '工具专词'] }),
      lore('来源', { keys: ['创作者关键词'], matchSources: ['creator_notes'], position: 'at_depth', content: '命中' }),
    ]
    expect(buildPrompt(value).report.worldInfo.map((entry) => entry.activated)).toEqual([false, true])
  })
})

describe('示例对话', () => {
  test('切块、宏前缀和实际名字、中英文冒号、多行和无前缀 system', () => {
    const value = minimal()
    value.history = []
    value.preset.prompts = [custom('examples')]
    value.speaker.fields.mes_example =
      '<START>开头\n{{USER}}：你好{{char}}\n下一行\n{{char}}: 好\n<start>小红: 问\n小明：答'
    expect(splitExamples(value.speaker.fields.mes_example)).toHaveLength(2)
    expect(contents(value)).toEqual(['[示例对话]', '开头', '你好小明\n下一行', '好', '[示例对话]', '问', '答'])
  })
  test('角色名自身带冒号时原始宏仍可识别', () => {
    const value = minimal()
    value.preset.prompts = [custom('examples')]
    value.speaker.name = '名字:内容'
    value.speaker.fields.mes_example = '{{char}}: 回复'
    expect(buildPrompt(value).messages.at(-1)).toEqual({ role: 'assistant', content: '回复' })
  })
  test('before_em、角色卡、after_em 顺序与 disabled', () => {
    const value = minimal()
    value.preset.prompts = [custom('examples')]
    value.preset.utility.newExampleChat = ''
    value.speaker.fields.mes_example = '{{user}}: 卡片'
    value.lore.entries = [
      lore('前', { constant: true, position: 'before_em', content: '{{user}}: 前' }),
      lore('后', { constant: true, position: 'after_em', content: '{{char}}: 后' }),
    ]
    expect(contents(value)).toEqual(['前', '卡片', '后'])
    value.preset.behavior.exampleBehavior = 'disabled'
    expect(contents(value)).toEqual([])
  })
  test('gradual 历史优先且按块停止，keep 计入固定部分', () => {
    const value = minimal()
    value.preset.prompts.unshift(custom('examples'))
    value.preset.utility.newExampleChat = ''
    value.speaker.fields.mes_example = '{{user}}: 示例示例示例示例示例示例示例'
    const historicalCost = value.history.reduce((sum, message) => sum + tokenCost(message.content), 0)
    setBudget(value, historicalCost)
    expect(contents(value)).toEqual(['你好', '您好'])
    value.preset.behavior.exampleBehavior = 'keep'
    expect(() => buildPrompt(value)).toThrow(PromptBudgetError)
  })
})

describe('预算和工具单元', () => {
  test('从最新往旧截断，遇到放不下的单元就停止', () => {
    const value = minimal()
    value.history = [
      history('1', 'user', '旧'),
      history('2', 'assistant', '很长'.repeat(50)),
      history('3', 'user', '新'),
    ]
    setBudget(value, tokenCost('新') + tokenCost('旧'))
    const result = buildPrompt(value)
    expect(result.messages).toEqual([{ role: 'user', content: '新' }])
    expect(result.report.historyKept).toBe(1)
    expect(result.report.historyTotal).toBe(3)
  })
  test('固定片段超过预算报中文差额', () => {
    const value = minimal()
    value.preset.prompts.unshift(custom('固定', { content: '长'.repeat(100) }))
    setBudget(value, 10)
    expect(() => buildPrompt(value)).toThrow(/固定提示词超出预算 \d+ token/)
  })
  for (const toolsEnabled of [true, false]) {
    test(`工具输出及成对保留/丢弃：toolsEnabled=${toolsEnabled}`, () => {
      const value = minimal()
      value.enabledTools = toolsEnabled ? ['search', 'next'] : []
      const call = history('调用', 'assistant', '查询')
      call.toolCalls = [
        { id: 'call', name: 'search', arguments: '{"q":1}' },
        { id: 'call2', name: 'next', arguments: '{}' },
      ]
      const result = { ...history('结果', 'tool', '答案'), name: 'search', toolCallId: 'call' }
      const result2 = { ...history('结果二', 'tool', '二'), name: 'next', toolCallId: 'call2' }
      value.history = [
        history('旧', 'user', '很长'.repeat(100)),
        call,
        result,
        result2,
        history('最新', 'user', '结束'),
      ]
      const built = buildPrompt(value)
      if (toolsEnabled) {
        expect(built.messages[1]!.tool_calls?.[0]).toEqual({
          id: 'call',
          type: 'function',
          function: { name: 'search', arguments: '{"q":1}' },
        })
        expect(built.messages[2]!.tool_call_id).toBe('call')
        expect(built.messages[2]!.role).toBe('tool')
      } else {
        expect(built.messages.map((message) => message.content)).toEqual(['很长'.repeat(100), '查询', '结束'])
        expect(built.messages.every((message) => !message.tool_calls && message.role !== 'tool')).toBe(true)
        expect(built.report.omittedToolCalls).toBe(2)
        return
      }
      const unitBudget = built.messages.slice(1).reduce((sum, m) => sum + tokenCost(m.content), 0)
      setBudget(value, unitBudget)
      expect(buildPrompt(value).report.historyKept).toBe(4)
      setBudget(value, unitBudget - 1)
      expect(buildPrompt(value).report.historyKept).toBe(1)
    })
  }
  test('工具调用和结果不被后处理合并', () => {
    const value = minimal()
    value.preset.behavior.postProcessing = 'merge'
    value.enabledTools = ['f']
    value.history = [
      history('a', 'assistant', '前'),
      { ...history('b', 'assistant', ''), toolCalls: [{ id: 't', name: 'f', arguments: '{}' }] },
      { ...history('c', 'tool', '结果'), toolCallId: 't' },
    ]
    expect(buildPrompt(value).messages.map((message) => message.role)).toEqual(['assistant', 'assistant', 'tool'])
  })
})

describe('群聊', () => {
  function groupInput(): BuildInput {
    const value = minimal()
    value.preset.prompts = [
      custom('char_description'),
      custom('char_personality'),
      custom('scenario'),
      custom('examples'),
      custom('history'),
    ]
    value.speaker.muted = true
    value.speaker.fields.personality = '性格甲'
    value.speaker.fields.scenario = '场景甲'
    value.speaker.fields.mes_example = '{{char}}: 示例甲'
    const other = {
      ...value.speaker,
      id: 'other',
      name: '小李',
      muted: false,
      fields: characterFieldsSchema.parse({
        name: '小李',
        description: '背景乙',
        personality: '性格乙',
        scenario: '场景乙',
        mes_example: '小李：示例乙',
      }),
    }
    const muted = {
      ...other,
      id: 'muted',
      name: '静音',
      muted: true,
      fields: characterFieldsSchema.parse({ name: '静音', description: '静音背景', mes_example: '静音: 静音示例' }),
    }
    value.group = { name: '群', members: [value.speaker, other, muted], mode: 'swap', scenarioOverride: '' }
    value.preset.behavior.namesBehavior = 'none'
    return value
  }
  test('swap 只用发言卡，群聊开场与 nudge', () => {
    const value = groupInput()
    const result = contents(value)
    expect(result).toContain('角色背景')
    expect(result.join('')).not.toContain('背景乙')
    expect(result).toContain('[开始新的群聊。成员：小明、小李、静音]')
    expect(result.at(-1)).toBe('[接下来只以小明的身份写一条回复。]')
  })
  test('join 排除静音成员，保留静音发言者并合并示例', () => {
    const value = groupInput()
    value.group!.mode = 'join'
    const result = contents(value)
    expect(result[0]).toBe('小明：\n角色背景\n小李：\n背景乙')
    expect(result[1]).toBe('小明：\n性格甲\n小李：\n性格乙')
    expect(result[2]).toBe('小明：\n场景甲\n小李：\n场景乙')
    expect(result).toContain('示例乙')
    expect(result.join('')).not.toContain('静音背景')
  })
  test('join_include_muted 与 scenarioOverride', () => {
    const value = groupInput()
    value.group!.mode = 'join_include_muted'
    value.group!.scenarioOverride = '覆盖场景{{char}}'
    const result = contents(value)
    expect(result[0]).toContain('静音：\n静音背景')
    expect(result[2]).toBe('覆盖场景小明')
    expect(result).toContain('静音示例')
  })
})

describe('生成模式和名字', () => {
  test('continue 提示使用最后一条原文，忽略普通预填充', () => {
    const value = minimal()
    value.type = 'continue'
    value.preset.behavior.assistantPrefill = '普通预填充'
    expect(contents(value).at(-1)).toContain('您好')
    expect(contents(value)).not.toContain('普通预填充')
  })
  test('continuePrefill 原消息移到 post_history 与群聊提示之后，保留原文空白', () => {
    const value = minimal()
    value.type = 'continue'
    value.preset.behavior.continuePrefill = true
    value.preset.behavior.namesBehavior = 'content'
    value.history[1]!.content = '  {{char}}原文\n'
    value.preset.prompts.push(custom('post_history', { content: '后指令' }))
    const result = buildPrompt(value)
    expect(result.messages.at(-1)).toEqual({ role: 'assistant', content: '  {{char}}原文\n' })
    expect(result.messages.at(-2)!.content).toBe('后指令')
    expect(result.report.historyKept).toBe(2)
    expect(result.report.segments.at(-1)?.messageId).toBe('a')
  })
  test('impersonate 提示与预填充，普通模式 assistantPrefill', () => {
    const value = minimal()
    value.type = 'impersonate'
    value.group = { name: '群', members: [value.speaker], mode: 'swap', scenarioOverride: '' }
    value.preset.behavior.assistantImpersonationPrefill = '{{user}}说'
    value.preset.behavior.assistantPrefill = '{{char}}说'
    let result = contents(value)
    expect(result.at(-2)).toContain('以小红的视角')
    expect(result.at(-1)).toBe('小红说')
    expect(result.join('')).not.toContain('接下来只以')
    value.type = 'normal'
    result = contents(value)
    expect(result.at(-1)).toBe('小明说')
  })
  for (const mode of ['none', 'default', 'content', 'completion'] as const) {
    test(`名字行为 ${mode} 同时处理历史和示例`, () => {
      const value = minimal()
      value.preset.behavior.namesBehavior = mode
      value.preset.prompts.unshift(custom('examples'))
      value.preset.utility.newExampleChat = ''
      value.speaker.fields.mes_example = '{{user}}: 例问\n{{char}}: 例答'
      const prefixed = mode === 'content' || mode === 'completion'
      expect(contents(value)).toEqual(
        prefixed ? ['小红: 例问', '小明: 例答', '小红: 你好', '小明: 您好'] : ['例问', '例答', '你好', '您好'],
      )
      value.group = { name: '群', members: [value.speaker], mode: 'swap', scenarioOverride: '' }
      if (mode === 'default') expect(contents(value)[0]).toBe('小红: 例问')
    })
  }
  test('completion 清理 name 并截到 64 字符', () => {
    const value = minimal()
    value.preset.behavior.namesBehavior = 'completion'
    value.history[0]!.name = `中文A-_${'x'.repeat(80)}!`
    expect(buildPrompt(value).messages[0]!.name).toBe(`A-_${'x'.repeat(61)}`)
    expect(buildPrompt(value).messages[0]!.content).toBe('你好')
  })
})

describe('后处理与报告', () => {
  for (const mode of ['none', 'merge', 'semi_strict', 'strict', 'single_user'] as const) {
    test(`postProcessing=${mode}`, () => {
      const value = minimal()
      value.preset.behavior.postProcessing = mode
      value.preset.prompts = [custom('s1'), custom('s2'), custom('history'), custom('s3')]
      value.history = [history('a', 'assistant', '答一'), history('b', 'assistant', '答二')]
      const result = buildPrompt(value)
      const roles: Record<typeof mode, HistoryMessage['role'][]> = {
        none: ['system', 'system', 'assistant', 'assistant', 'system'],
        merge: ['system', 'assistant', 'system'],
        semi_strict: ['system', 'assistant', 'user'],
        strict: ['system', 'user', 'assistant', 'user'],
        single_user: ['user'],
      }
      expect(result.messages.map((message) => message.role)).toEqual(roles[mode])
      if (mode === 'strict') expect(result.messages[1]!.content).toBe('[开始]')
      if (mode === 'single_user') expect(result.messages[0]!.content).toBe('s1\n\ns2\n\n答一\n\n答二\n\ns3')
      expect(result.report.segments.map((segment) => segment.content)).toEqual(['s1', 's2', '答一', '答二', 's3'])
      expect(result.report.totalTokens).toBe(result.messages.reduce((total, m) => total + tokenCost(m.content), 0))
    })
  }
  test('squashSystem 只合并普通相邻 system，示例 system 保持独立', () => {
    const value = minimal()
    value.history = []
    value.preset.prompts = [custom('s1'), custom('s2'), custom('examples'), custom('s3')]
    value.preset.behavior.squashSystem = true
    value.speaker.fields.mes_example = '说明'
    expect(contents(value)).toEqual(['s1\n\ns2', '[示例对话]', '说明', 's3'])
  })
  test('single_user 丢弃所有名字与工具字段', () => {
    const value = minimal()
    value.enabledTools = ['f']
    value.preset.behavior.namesBehavior = 'completion'
    value.preset.behavior.postProcessing = 'single_user'
    value.history = [
      { ...history('a', 'assistant', '调用'), name: 'A', toolCalls: [{ id: 'f', name: 'f', arguments: '{}' }] },
      { ...history('t', 'tool', '结果'), toolCallId: 'f' },
    ]
    expect(buildPrompt(value).messages).toEqual([{ role: 'user', content: '调用\n\n结果' }])
  })
  test('输入不被修改，相同输入可复现', () => {
    const value = input()
    value.preset.prompts.push(custom('随机', { content: '{{random::一::二}} {{roll:2d6}}' }))
    const before = structuredClone(value)
    const first = buildPrompt(value)
    expect(buildPrompt(value)).toEqual(first)
    expect(value).toEqual(before)
  })
})

describe('边界回归', () => {
  test('组装上下文提供 group、lastChatMessage 和扩展宏，内置宏保持优先', () => {
    const value = minimal()
    value.preset.prompts = [custom('宏', { content: '{{GROUP}}/{{LastChatMessage}}/{{扩展::参数}}/{{char}}' })]
    value.macros = { 扩展: (arg) => `[${arg}]`, char: () => '错误覆盖' }
    expect(contents(value)).toEqual(['小明/您好/[参数]/小明'])
    value.group = {
      name: '群名',
      members: [value.speaker, { ...value.speaker, id: 'b', name: '乙' }],
      mode: 'swap',
      scenarioOverride: '',
    }
    value.preset.utility.groupNudge = ''
    expect(contents(value)).toEqual(['小明、乙/您好/[参数]/小明'])
  })
  test('outlet 内容支持带宏的世界书格式', () => {
    const value = minimal()
    value.preset.prompts = [custom('槽', { content: '{{outlet::槽}}' })]
    value.preset.utility.worldInfoFormat = '{{char}}：{0}'
    value.lore.entries = [lore('槽', { position: 'outlet', outletName: '槽', constant: true, content: '内容' })]
    expect(contents(value)).toEqual(['小明：内容'])
  })
  test('群聊卡片经宏展开为空时不留下名字标签', () => {
    const value = minimal()
    value.speaker.fields.description = '{{outlet::不存在}}'
    value.group = { name: '群', members: [value.speaker], mode: 'join', scenarioOverride: '' }
    value.preset.prompts = [custom('char_description')]
    value.preset.utility.groupNudge = ''
    expect(contents(value)).toEqual([])
  })
  test('性格场景格式、空字段跳过，不影响非空覆盖场景', () => {
    const value = minimal()
    value.preset.prompts = [custom('char_personality'), custom('scenario')]
    value.preset.utility.personalityFormat = '性格：{{personality}}，{{char}}'
    value.preset.utility.scenarioFormat = '场景：{{scenario}}，{{user}}'
    expect(contents(value)).toEqual([])
    value.speaker.fields.personality = '开朗'
    value.speaker.fields.scenario = '酒馆'
    expect(contents(value)).toEqual(['性格：开朗，小明', '场景：酒馆，小红'])
  })
  test('gradual 用历史后的余额按块加入，keep 先占固定预算', () => {
    const value = minimal()
    value.preset.prompts.unshift(custom('examples'))
    value.preset.utility.newExampleChat = ''
    value.history = [history('旧', 'user', '旧记录旧记录'), history('新', 'assistant', '新')]
    value.speaker.fields.mes_example = '<START>{{user}}: 甲<START>{{char}}: 很长'
    const historyTokens = value.history.reduce((total, message) => total + tokenCost(message.content), 0)
    setBudget(value, historyTokens + tokenCost('甲'))
    expect(contents(value)).toEqual(['甲', '旧记录旧记录', '新'])
    value.preset.behavior.exampleBehavior = 'keep'
    const result = buildPrompt(value)
    expect(result.messages.slice(0, 2).map((message) => message.content)).toEqual(['甲', '很长'])
    expect(result.report.historyKept).toBe(1)
  })
  test('没有保留历史时不发送 newChat，历史存在时开场不参与深度计算', () => {
    const value = minimal()
    value.preset.utility.newChat = '开场'
    value.preset.prompts.push(custom('注入', { position: 'in_chat', depth: 999 }))
    expect(contents(value)).toEqual(['开场', '注入', '你好', '您好'])
    value.history = []
    expect(contents(value)).toEqual(['注入'])
  })
  test('无历史占位仍保留作者注释，角色备注和结尾计入固定预算', () => {
    const value = minimal()
    value.preset.prompts = []
    value.chat.authorNote = '作者注释'
    value.speaker.extras.characterNote = '角色备注'
    value.preset.behavior.assistantPrefill = '回复预填充'
    expect(contents(value)).toEqual(['作者注释\n角色备注', '回复预填充'])
    setBudget(value, 5)
    expect(() => buildPrompt(value)).toThrow(PromptBudgetError)
  })
  test('continuePrefill 只剩被续写消息时仍在末尾保留原文', () => {
    const value = minimal()
    value.type = 'continue'
    value.preset.behavior.continuePrefill = true
    value.preset.behavior.postProcessing = 'merge'
    value.history = [history('旧', 'assistant', '旧'.repeat(100)), history('续', 'assistant', '续')]
    setBudget(value, tokenCost('续'))
    const result = buildPrompt(value)
    expect(result.messages).toEqual([{ role: 'assistant', content: '续' }])
    expect(result.report.historyKept).toBe(1)
  })
  test('completion 对示例使用人设名与当前角色名，并保留真实历史名字', () => {
    const value = minimal()
    value.preset.prompts.unshift(custom('examples'))
    value.preset.utility.newExampleChat = ''
    value.speaker.name = 'Char'
    value.persona.name = 'User'
    value.speaker.fields.mes_example = '{{user}}: 问\n{{char}}: 答'
    value.history[0]!.name = 'PastUser'
    value.history[1]!.name = 'PastChar'
    value.preset.behavior.namesBehavior = 'completion'
    expect(buildPrompt(value).messages.map((message) => message.name)).toEqual(['User', 'Char', 'PastUser', 'PastChar'])
  })
  test('省略孤立工具结果后 semi_strict 合并普通正文', () => {
    const value = minimal()
    value.preset.behavior.squashSystem = true
    value.preset.behavior.postProcessing = 'semi_strict'
    value.history = [
      history('u', 'user', '问'),
      { ...history('t', 'tool', '结果'), name: 'f', toolCallId: 'f' },
      history('s', 'system', '提示'),
    ]
    expect(buildPrompt(value).messages).toEqual([{ role: 'user', content: '问\n\n提示' }])
  })
})

describe('图片组装', () => {
  test('关闭图片时每张转为文字，占位图片消息保持边界', () => {
    const value = minimal()
    value.history = [{ ...history('u', 'user', '看这里'), images: ['a', 'b'] }, history('v', 'user', '下一条')]
    value.preset.behavior.postProcessing = 'merge'
    const result = buildPrompt(value)
    expect(result.messages).toEqual([
      { role: 'user', content: '看这里\n[图片]\n[图片]' },
      { role: 'user', content: '下一条' },
    ])
  })
  test('从最新往前限制图片，同条消息保留靠后的图片，0 不限', () => {
    const value = minimal()
    value.preset.samplers.inlineImages = true
    value.preset.samplers.imageLimit = 2
    value.history = [
      { ...history('u', 'user', '旧图'), images: ['a', 'b'] },
      { ...history('v', 'user', ''), images: ['c'] },
    ]
    expect(buildPrompt(value).messages).toEqual([
      { role: 'user', content: '旧图\n[图片]', images: ['b'] },
      { role: 'user', content: '', images: ['c'] },
    ])
    value.preset.samplers.imageLimit = 0
    expect(buildPrompt(value).messages.flatMap((message) => message.images ?? [])).toEqual(['a', 'b', 'c'])
  })
  test('每张保留图片按 300 token 计入报告和历史截断', () => {
    const value = minimal()
    value.preset.samplers.inlineImages = true
    value.history = [{ ...history('u', 'user', ''), images: ['a'] }]
    const result = buildPrompt(value)
    expect(result.report.totalTokens).toBe(300 + tokenCost(''))
    expect(result.report.segments[0]?.tokens).toBe(300 + tokenCost(''))
    setBudget(value, 299)
    expect(buildPrompt(value).report.historyKept).toBe(0)
  })
  test('所有后处理模式都保留图片字段与消息边界，续写图片也参与限制', () => {
    for (const mode of ['none', 'merge', 'semi_strict', 'strict', 'single_user'] as const) {
      const value = minimal()
      value.preset.behavior.postProcessing = mode
      value.preset.samplers.inlineImages = true
      value.history = [
        history('a', 'user', '前'),
        { ...history('u', 'user', ''), images: ['a'] },
        history('v', 'user', '后'),
      ]
      expect(buildPrompt(value).messages.find((message) => message.images?.length)).toEqual({
        role: 'user',
        content: '',
        images: ['a'],
      })
    }
    const value = minimal()
    value.type = 'continue'
    value.preset.behavior.continuePrefill = true
    value.preset.samplers.inlineImages = true
    value.history = [{ ...history('a', 'assistant', '续写'), images: ['a'] }]
    expect(buildPrompt(value).messages.at(-1)?.images).toEqual(['a'])
  })
})

describe('历史消息的宏', () => {
  test('开场白和历史里的 {{user}} {{char}} 会被替换', () => {
    const value = minimal()
    value.history = [
      history('g', 'assistant', '{{char}} stood awkwardly in front of {{user}}. <USER>'),
      history('u', 'user', '我是{{user}}，你是{{char}}吗'),
    ]
    const { messages } = buildPrompt(value)
    expect(messages.map((m) => m.content)).toEqual([
      '小明 stood awkwardly in front of 小红. 小红',
      '我是小红，你是小明吗',
    ])
  })

  test('群聊里角色消息的 {{char}} 指说这句话的角色', () => {
    const value = minimal()
    value.history = [{ ...history('a', 'assistant', '我是{{char}}'), name: '莱恩', speakerId: 'lyon' }]
    expect(buildPrompt(value).messages[0]?.content).toBe('我是莱恩')
  })
})

describe('启用工具历史过滤', () => {
  const calls = [
    { id: 'a', name: 'search', arguments: '{}' },
    { id: 'b', name: 'generate_image', arguments: '{}' },
  ]
  const records: HistoryMessage[] = [
    { ...history('调用', 'assistant', ''), toolCalls: calls },
    { ...history('结果甲', 'tool', '检索结果'), toolCallId: 'a' },
    { ...history('结果乙', 'tool', '图片结果'), toolCallId: 'b' },
  ]
  test('同条消息内按工具名筛选配对，且不修改原历史', () => {
    const value = minimal()
    value.enabledTools = ['search']
    value.history = structuredClone(records)
    const before = structuredClone(value.history)
    const built = buildPrompt(value)
    expect(built.messages[0]?.tool_calls?.map((call) => call.function.name)).toEqual(['search'])
    expect(built.messages[1]).toMatchObject({ role: 'tool', tool_call_id: 'a', content: '检索结果' })
    expect(built.messages).toHaveLength(2)
    expect(built.report.omittedToolCalls).toBe(1)
    expect(value.history).toEqual(before)
  })
  test('空集删除无正文的调用消息及所有结果，宏也看不到被省略的结果', () => {
    const value = minimal()
    value.history = records
    expect(buildPrompt(value).messages).toEqual([])
    expect(buildPrompt(value).report.omittedToolCalls).toBe(2)
  })
  test('纯函数丢弃未完成调用、孤立结果和重复结果', () => {
    const value = [
      { ...history('孤立', 'tool', '孤立结果'), toolCallId: 'other' },
      ...records.slice(0, 2),
      { ...history('重复', 'tool', '重复结果'), toolCallId: 'a' },
    ]
    const result = filterToolHistory(value, ['search', 'generate_image'])
    expect(result.history).toHaveLength(2)
    expect(result.history[0]?.toolCalls).toEqual([calls[0]!])
    expect(result.history[1]?.content).toBe('检索结果')
    expect(result.omittedToolCalls).toBe(0)
  })
})

test('深度注入不拆开工具调用与结果', () => {
  const value = minimal()
  value.enabledTools = ['search']
  value.chat.authorNote = '注入'
  value.chat.authorNoteDepth = 1
  value.history = [
    { ...history('调用', 'assistant', ''), toolCalls: [{ id: 'a', name: 'search', arguments: '{}' }] },
    { ...history('结果', 'tool', '结果'), toolCallId: 'a' },
  ]
  expect(buildPrompt(value).messages.map((m) => m.role)).toEqual(['system', 'assistant', 'tool'])
})
