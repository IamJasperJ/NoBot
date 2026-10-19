import {
  BUILTIN_PROMPTS,
  behaviorSchema,
  generationTypeSchema,
  type PresetData,
  promptBlockSchema,
  samplerSchema,
} from '@nobot/shared'
import { DEFAULT_UTILITY_PROMPTS_EN, parsePresetWithEnglishDefaults } from '../prompt/defaults'
import { object, readMap, requireObject, sanitize, strings, writeMap } from './utils'

const samplerMap = {
  temperature: 'temperature',
  frequencyPenalty: 'frequency_penalty',
  presencePenalty: 'presence_penalty',
  topP: 'top_p',
  topK: 'top_k',
  topA: 'top_a',
  minP: 'min_p',
  repetitionPenalty: 'repetition_penalty',
  contextSize: 'openai_max_context',
  maxTokens: 'openai_max_tokens',
  stream: 'stream_openai',
  seed: 'seed',
  n: 'n',
  functionCalling: 'function_calling',
  requestReasoning: 'show_thoughts',
  webSearch: 'enable_web_search',
  inlineImages: 'image_inlining',
}
const behaviorMap = {
  continuePrefill: 'continue_prefill',
  continuePostfix: 'continue_postfix',
  squashSystem: 'squash_system_messages',
  wrapInQuotes: 'wrap_in_quotes',
  assistantPrefill: 'assistant_prefill',
  assistantImpersonationPrefill: 'assistant_impersonation',
  useSystemPrompt: 'claude_use_sysprompt',
}
const utilityMap = {
  worldInfoFormat: 'wi_format',
  scenarioFormat: 'scenario_format',
  personalityFormat: 'personality_format',
  groupNudge: 'group_nudge_prompt',
  newChat: 'new_chat_prompt',
  newGroupChat: 'new_group_chat_prompt',
  newExampleChat: 'new_example_chat_prompt',
  continueNudge: 'continue_nudge_prompt',
  impersonation: 'impersonation_prompt',
  sendIfEmpty: 'send_if_empty',
}
const builtinMap: Record<string, keyof typeof BUILTIN_PROMPTS> = {
  main: 'main',
  nsfw: 'auxiliary',
  jailbreak: 'post_history',
  enhanceDefinitions: 'enhance_definitions',
  worldInfoBefore: 'wi_before',
  worldInfoAfter: 'wi_after',
  charDescription: 'char_description',
  charPersonality: 'char_personality',
  scenario: 'scenario',
  personaDescription: 'persona',
  dialogueExamples: 'examples',
  chatHistory: 'history',
}
const names = { '-1': 'none', '0': 'default', '1': 'completion', '2': 'content' }
const processing = { '': 'none', merge: 'merge', semi: 'semi_strict', strict: 'strict', single: 'single_user' }
const reasoning = { auto: 'auto', min: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'high' }
const lookup = (map: Record<string, string>, key: unknown) =>
  (typeof key === 'string' || typeof key === 'number') && Object.hasOwn(map, key) ? map[String(key)] : undefined
const reverse = (map: Record<string, string>, value: string) => Object.keys(map).find((key) => map[key] === value)

function importPrompts(json: Record<string, unknown>): PresetData['prompts'] | undefined {
  const groups = Array.isArray(json.prompt_order) ? json.prompt_order.map(object) : []
  const group =
    groups.find((g) => g.character_id === 100001) ?? groups.find((g) => g.character_id === 100000) ?? groups[0]
  const order = Array.isArray(group?.order) ? group.order.map(object) : []
  if (!Array.isArray(json.prompts) && !Array.isArray(group?.order)) return undefined
  const prompts = new Map<string, Record<string, unknown>>()
  for (const item of Array.isArray(json.prompts) ? json.prompts : []) {
    const prompt = object(item)
    if (typeof prompt.identifier === 'string' && prompt.identifier.length) prompts.set(prompt.identifier, prompt)
  }
  const result: PresetData['prompts'] = []
  const seen = new Set<string>()
  const append = (identifier: unknown, enabled: unknown) => {
    if (typeof identifier !== 'string' || seen.has(identifier)) return
    seen.add(identifier)
    const builtin = Object.hasOwn(builtinMap, identifier) ? builtinMap[identifier] : undefined
    const source = prompts.get(identifier)
    if (!source && !builtin) return
    const fallback = parsePresetWithEnglishDefaults({}).prompts.find((p) => p.id === builtin)
    if (!source && fallback) {
      result.push(
        sanitize(promptBlockSchema, {
          ...fallback,
          enabled: typeof enabled === 'boolean' ? enabled : fallback.enabled,
        }),
      )
      return
    }
    const p = source ?? {}
    result.push(
      sanitize(promptBlockSchema, {
        id: builtin ?? identifier,
        name:
          typeof p.name === 'string' && p.name.trim() ? p.name : builtin ? BUILTIN_PROMPTS[builtin].name : '自定义条目',
        content: builtin && (p.marker === true || BUILTIN_PROMPTS[builtin].marker) ? '' : p.content,
        role: p.role,
        enabled: typeof enabled === 'boolean' ? enabled : p.enabled,
        position: p.injection_position === 1 ? 'in_chat' : 'relative',
        depth: p.injection_depth,
        order: p.injection_order,
        triggers: strings(p.injection_trigger)?.filter((t) => generationTypeSchema.safeParse(t).success),
      }),
    )
  }
  for (const item of order) append(item.identifier, item.enabled)
  for (const identifier of prompts.keys()) append(identifier, false)
  return result
}

export function importSTPreset(json: unknown): PresetData {
  const input = requireObject(json)
  const extension = object(input.nobot)
  return parsePresetWithEnglishDefaults({
    samplers: sanitize(samplerSchema, {
      ...object(extension.samplers),
      ...readMap(input, samplerMap),
      reasoningEffort: lookup(reasoning, input.reasoning_effort),
    }),
    behavior: sanitize(behaviorSchema, {
      ...object(extension.behavior),
      ...readMap(input, behaviorMap),
      namesBehavior: typeof input.names_behavior === 'number' ? lookup(names, input.names_behavior) : undefined,
      postProcessing: lookup(processing, input.custom_prompt_post_processing),
    }),
    utility: {
      ...DEFAULT_UTILITY_PROMPTS_EN,
      ...Object.fromEntries(
        Object.entries(readMap(input, utilityMap)).filter(([, value]) => typeof value === 'string'),
      ),
    },
    prompts: importPrompts(input),
  })
}

export function exportSTPreset(data: PresetData): Record<string, unknown> {
  return {
    ...writeMap(data.samplers, samplerMap),
    ...writeMap(data.behavior, behaviorMap),
    ...writeMap(data.utility, utilityMap),
    reasoning_effort: reverse(reasoning, data.samplers.reasoningEffort),
    names_behavior: Number(reverse(names, data.behavior.namesBehavior)),
    custom_prompt_post_processing: reverse(processing, data.behavior.postProcessing),
    // 规格未定义酒馆字段的设置放在专属扩展内，避免冒用酒馆字段并保证本应用往返无损。
    nobot: {
      samplers: {
        logitBias: structuredClone(data.samplers.logitBias),
        stop: [...data.samplers.stop],
        extraBody: data.samplers.extraBody,
      },
      behavior: {
        preferCharPrompt: data.behavior.preferCharPrompt,
        preferCharInstructions: data.behavior.preferCharInstructions,
        exampleBehavior: data.behavior.exampleBehavior,
      },
    },
    prompts: data.prompts.map((p) => {
      const identifier = reverse(builtinMap, p.id) ?? p.id
      const builtin = Object.hasOwn(BUILTIN_PROMPTS, p.id)
        ? BUILTIN_PROMPTS[p.id as keyof typeof BUILTIN_PROMPTS]
        : undefined
      return {
        identifier,
        name: p.name,
        role: p.role,
        content: p.content,
        enabled: p.enabled,
        ...(builtin ? { system_prompt: true, ...(builtin.marker ? { marker: true } : {}) } : {}),
        injection_position: p.position === 'in_chat' ? 1 : 0,
        injection_depth: p.depth,
        injection_order: p.order,
        injection_trigger: [...p.triggers],
      }
    }),
    prompt_order: [
      {
        character_id: 100001,
        order: data.prompts.map((p) => ({ identifier: reverse(builtinMap, p.id) ?? p.id, enabled: p.enabled })),
      },
    ],
  }
}
