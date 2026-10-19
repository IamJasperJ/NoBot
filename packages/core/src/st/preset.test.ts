import { describe, expect, test } from 'bun:test'
import { presetDataSchema, promptBlockSchema } from '@nobot/shared'
import { parsePresetWithEnglishDefaults } from '../prompt/defaults'
import { exportSTPreset, importSTPreset, STFormatError } from './index'

const preset = {
  temperature: 1.2,
  frequency_penalty: 0.2,
  presence_penalty: -0.3,
  top_p: 0.9,
  top_k: 42,
  top_a: 0.1,
  min_p: 0.05,
  repetition_penalty: 1.1,
  openai_max_context: 32768,
  openai_max_tokens: 2048,
  stream_openai: false,
  seed: 123,
  n: 2,
  function_calling: true,
  show_thoughts: true,
  reasoning_effort: 'min',
  enable_web_search: true,
  image_inlining: true,
  names_behavior: 2,
  continue_prefill: true,
  continue_postfix: '\n\n',
  squash_system_messages: true,
  wrap_in_quotes: true,
  custom_prompt_post_processing: 'semi',
  assistant_prefill: '开场',
  assistant_impersonation: '代写',
  claude_use_sysprompt: true,
  wi_format: '<世界>{0}</世界>',
  scenario_format: '场景：{{scenario}}',
  personality_format: '性格：{{personality}}',
  group_nudge_prompt: '群聊',
  new_chat_prompt: '新对话',
  new_group_chat_prompt: '新群聊',
  new_example_chat_prompt: '示例',
  continue_nudge_prompt: '继续',
  impersonation_prompt: '模仿',
  send_if_empty: '你好',
  prompts: [
    {
      identifier: 'main',
      name: '主提示词',
      role: 'system',
      content: '你是{{char}}',
      system_prompt: true,
      enabled: false,
    },
    { identifier: 'worldInfoBefore', name: '世界书', marker: true, content: '忽略此内容' },
    {
      identifier: 'uuid-custom',
      name: '',
      role: 'user',
      content: '自定义指令',
      injection_position: 1,
      injection_depth: 2,
      injection_order: 31,
      injection_trigger: ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet', 'unknown', 1],
    },
    { identifier: 'orphan', name: '未排序条目', content: '末尾', enabled: true },
  ],
  prompt_order: [
    { character_id: 100000, order: [{ identifier: 'orphan', enabled: true }] },
    {
      character_id: 100001,
      order: [
        { identifier: 'uuid-custom', enabled: true },
        { identifier: 'main', enabled: true },
        { identifier: 'worldInfoBefore', enabled: false },
        { identifier: 'jailbreak', enabled: false },
        { identifier: 'missing', enabled: true },
      ],
    },
  ],
}

describe('酒馆预设', () => {
  test('完整采样参数、行为与辅助提示词映射', () => {
    const result = importSTPreset(preset)
    expect(result.samplers).toEqual({
      ...presetDataSchema.parse({}).samplers,
      temperature: 1.2,
      frequencyPenalty: 0.2,
      presencePenalty: -0.3,
      topP: 0.9,
      topK: 42,
      topA: 0.1,
      minP: 0.05,
      repetitionPenalty: 1.1,
      contextSize: 32768,
      maxTokens: 2048,
      stream: false,
      seed: 123,
      n: 2,
      functionCalling: true,
      requestReasoning: true,
      reasoningEffort: 'minimal',
      webSearch: true,
      inlineImages: true,
    })
    expect(result.behavior).toEqual({
      ...presetDataSchema.parse({}).behavior,
      namesBehavior: 'content',
      continuePrefill: true,
      continuePostfix: '\n\n',
      squashSystem: true,
      wrapInQuotes: true,
      postProcessing: 'semi_strict',
      assistantPrefill: '开场',
      assistantImpersonationPrefill: '代写',
      useSystemPrompt: true,
    })
    expect(result.utility).toEqual({
      worldInfoFormat: '<世界>{0}</世界>',
      scenarioFormat: '场景：{{scenario}}',
      personalityFormat: '性格：{{personality}}',
      groupNudge: '群聊',
      newChat: '新对话',
      newGroupChat: '新群聊',
      newExampleChat: '示例',
      continueNudge: '继续',
      impersonation: '模仿',
      sendIfEmpty: '你好',
    })
    expect(result.prompts.map((p) => [p.id, p.enabled])).toEqual([
      ['uuid-custom', true],
      ['main', true],
      ['wi_before', false],
      ['post_history', false],
      ['orphan', false],
    ])
    expect(result.prompts[0]).toEqual({
      id: 'uuid-custom',
      name: '自定义条目',
      role: 'user',
      content: '自定义指令',
      enabled: true,
      position: 'in_chat',
      depth: 2,
      order: 31,
      triggers: ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'],
    })
    expect(result.prompts[1]?.content).toBe('你是{{char}}')
    expect(result.prompts[2]?.content).toBe('')
  })

  test('所有内置标识导入导出、缺失内置使用默认内容', () => {
    const pairs = [
      ['main', 'main'],
      ['nsfw', 'auxiliary'],
      ['jailbreak', 'post_history'],
      ['enhanceDefinitions', 'enhance_definitions'],
      ['worldInfoBefore', 'wi_before'],
      ['worldInfoAfter', 'wi_after'],
      ['charDescription', 'char_description'],
      ['charPersonality', 'char_personality'],
      ['scenario', 'scenario'],
      ['personaDescription', 'persona'],
      ['dialogueExamples', 'examples'],
      ['chatHistory', 'history'],
    ] as const
    const data = importSTPreset({
      prompt_order: [{ order: pairs.map(([identifier]) => ({ identifier, enabled: true })) }],
    })
    expect(data.prompts.map((p) => p.id)).toEqual(pairs.map(([, id]) => id))
    expect(data.prompts[0]?.content).toBe(parsePresetWithEnglishDefaults({}).prompts[0]?.content)
    const out = exportSTPreset(data)
    expect(out.prompts).toEqual(
      data.prompts.map((p, i) => ({
        identifier: pairs[i]?.[0],
        name: p.name,
        role: 'system',
        content: p.content,
        enabled: true,
        system_prompt: true,
        ...(i >= 4 ? { marker: true } : {}),
        injection_position: 0,
        injection_depth: 4,
        injection_order: 100,
        injection_trigger: [],
      })),
    )
    expect(out.prompt_order).toEqual([
      { character_id: 100001, order: pairs.map(([identifier]) => ({ identifier, enabled: true })) },
    ])
  })

  test('顺序组回退到 100000、第一组；未排序条目禁用', () => {
    for (const id of [100000, 7]) {
      const result = importSTPreset({
        ...preset,
        prompt_order: [{ character_id: id, order: [{ identifier: 'main', enabled: false }] }],
      })
      expect(result.prompts[0]?.id).toBe('main')
      expect(result.prompts.every((p) => !p.enabled)).toBe(true)
    }
    expect(importSTPreset({ prompts: preset.prompts }).prompts.every((p) => !p.enabled)).toBe(true)
    expect(importSTPreset({ prompts: [] }).prompts).toEqual([])
  })

  test('内置文本被标记为 marker 时清空，顺序开关缺失时保留条目开关', () => {
    const result = importSTPreset({
      prompts: [{ identifier: 'main', marker: true, content: '不应导入', enabled: false }],
      prompt_order: [
        { order: [{ identifier: 'main' }, { identifier: 'nsfw' }, { identifier: 'main', enabled: true }] },
      ],
    })
    expect(result.prompts.map((p) => [p.id, p.content, p.enabled])).toEqual([
      ['main', '', false],
      ['auxiliary', '', false],
    ])
  })

  test('行为、推理强度、连接符的全部枚举', () => {
    for (const [i, value] of (['none', 'default', 'completion', 'content'] as const).entries()) {
      const data = importSTPreset({ names_behavior: i - 1 })
      expect(data.behavior.namesBehavior).toBe(value)
      expect(exportSTPreset(data).names_behavior).toBe(i - 1)
    }
    for (const [st, ours] of [
      ['', 'none'],
      ['merge', 'merge'],
      ['semi', 'semi_strict'],
      ['strict', 'strict'],
      ['single', 'single_user'],
    ] as const) {
      const data = importSTPreset({ custom_prompt_post_processing: st })
      expect(data.behavior.postProcessing).toBe(ours)
      expect(exportSTPreset(data).custom_prompt_post_processing).toBe(st)
    }
    for (const [st, ours] of [
      ['auto', 'auto'],
      ['min', 'minimal'],
      ['low', 'low'],
      ['medium', 'medium'],
      ['high', 'high'],
      ['max', 'high'],
    ] as const) {
      const data = importSTPreset({ reasoning_effort: st })
      expect(data.samplers.reasoningEffort).toBe(ours)
      expect(importSTPreset(exportSTPreset(data))).toEqual(data)
    }
    for (const value of ['', ' ', '\n', '\n\n'] as const)
      expect(importSTPreset({ continue_postfix: value }).behavior.continuePostfix).toBe(value)
  })

  test('包含应用专用设置的非默认预设往返无损', () => {
    const data = importSTPreset(preset)
    data.samplers.stop = ['停止', '\n']
    data.samplers.logitBias = [{ text: '你好', value: -30 }]
    data.samplers.extraBody = '{"test":true}'
    data.behavior.preferCharPrompt = false
    data.behavior.preferCharInstructions = false
    data.behavior.exampleBehavior = 'keep'
    data.prompts.push(promptBlockSchema.parse({ id: 'another', name: '另一条', role: 'assistant' }))
    expect(importSTPreset(exportSTPreset(data))).toEqual(data)
    expect(importSTPreset(exportSTPreset(presetDataSchema.parse({})))).toEqual(presetDataSchema.parse({}))
  })

  test('空对象和损坏字段默认值、异常结构与危险属性名', () => {
    const defaults = parsePresetWithEnglishDefaults({})
    expect(importSTPreset({})).toEqual(defaults)
    expect(
      importSTPreset({
        temperature: '1',
        top_p: 2,
        top_k: -1,
        seed: Infinity,
        n: 1.5,
        openai_max_tokens: 0,
        names_behavior: '2',
        reasoning_effort: 'constructor',
        custom_prompt_post_processing: '__proto__',
        continue_postfix: '错误',
        wi_format: 1,
        stream_openai: 'false',
        prompts: null,
      }),
    ).toEqual(defaults)
    const invalid = importSTPreset({
      prompts: [
        null,
        {},
        { identifier: '' },
        {
          identifier: '__proto__',
          role: 'bad',
          injection_depth: -1,
          injection_order: NaN,
          content: {},
          injection_trigger: [false, 'quiet'],
        },
      ],
    })
    expect(invalid.prompts).toEqual([
      promptBlockSchema.parse({ id: '__proto__', name: '自定义条目', enabled: false, triggers: ['quiet'] }),
    ])
    for (const value of [null, [], 1, 'json', false]) expect(() => importSTPreset(value)).toThrow(STFormatError)
  })
})
