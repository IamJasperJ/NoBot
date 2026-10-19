export const modes = [
  { key: 'character', name: '角色（全身）', landscape: false },
  { key: 'face', name: '角色（脸部特写）', landscape: false },
  { key: 'user', name: '用户（人设）', landscape: false },
  { key: 'scene', name: '当前场景', landscape: true },
  { key: 'last', name: '最后一条消息', landscape: false },
  { key: 'message', name: '指定消息', landscape: false },
  { key: 'raw_last', name: '最后一条消息原文', landscape: false },
  { key: 'background', name: '背景', landscape: true },
  { key: 'free', name: '自由描述', landscape: false },
] as const
export type Mode = (typeof modes)[number]['key']

const last =
  'From the specified message, choose exactly one visually clear still-image moment. Describe only the main subject, one action or pose, expression, clothing state, immediate setting, lighting, and camera framing. If multiple events occur, choose the final or most visually striking moment. Do not include dialogue, thoughts, plot history, system panels, statistics, markup, variables, UI, captions, or multiple scenes.'
export const templates: Partial<Record<Mode, string>> = {
  character:
    'Ignore previous format requirements. Write an AI image prompt describing {{char}}, including number and gender, species, apparent age, hairstyle and hair color, eyes, build, clothing, accessories, pose, expression, and brief background. Use full body framing.',
  face: 'Ignore previous format requirements. Write a close-up AI image prompt for {{char}}, in this order: number and gender, species, apparent age, hairstyle and hair color, eyes, facial features, expression, and head accessories. Use close-up portrait framing and face focus.',
  user: 'Ignore previous format requirements. Write an AI image prompt describing {{user}} (the character played by the user), in this order: number and gender, species, apparent age, hairstyle and hair color, eyes, build, clothing, pose, and expression. Use full body framing. If appearance details are insufficient, infer plausible details from the available information.',
  scene:
    'Ignore previous format requirements. Write an AI image prompt for the current story scene: people present (number, gender, key appearance details, actions), location, time, lighting, weather, mood, and camera angle.',
  last,
  message: last,
  background:
    'Ignore previous format requirements. Write an AI image prompt for the current story location. Describe only the environment (location, architecture or landscape, time, lighting, weather, mood). No people may appear. Show scenery with no humans.',
  free: 'Ignore previous format requirements. Expand the following scene description into an AI image prompt:\n{{input}}',
}
export const templateEndings = {
  tags: 'Output only concise English, comma-separated visual keywords, 25–50 words. Include the subject, appearance, expression, clothing, pose or action, setting, lighting, and camera as appropriate to the task. Preserve established character names and visual identity. No story continuation, dialogue, markup, captions, or explanations.',
  natural:
    'Output only one paragraph of 40–90 words of natural English describing visible elements: subject appearance, clothing, expression, pose and action, environment, lighting, mood, and camera. No lists, quotes, explanations, or prefixes.',
}

/** 自定义模板保持原样，只有内置模板接受统一的格式结尾。 */
export function promptInstruction(mode: Mode, configured: unknown, style: 'tags' | 'natural'): string {
  const fallback = templates[mode] ?? ''
  const template = typeof configured === 'string' && configured ? configured : fallback
  return !configured || configured === fallback ? `${template}\n${templateEndings[style]}` : template
}

export function replaceTemplate(template: string, values: { char: string; user: string; input: string }): string {
  // 酒馆自由扩写使用 {0}；一次替换避免把用户输入中的宏再次展开。
  return template.replace(/{{(char|user|input)}}|\{0\}/g, (_, key: keyof typeof values | undefined) =>
    key ? values[key] : values.input,
  )
}

export function cleanPrompt(text: string, minimal = false): string {
  if (minimal) return text.replace(/\s+/g, ' ').trim()
  return (
    text
      .replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '')
      // 写提示词的模型偶尔会把舞台指令原样抄回来；只去掉这几种标签，A1111 的 <lora:名字:权重> 要保留
      .replace(/<(state|choices)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, ' ')
      .replace(/<\/?(?:scene|show|hide|say|expr|cg|sfx|bgm)\b[^>]*>/gi, ' ')
      .replace(/```[a-z0-9_-]*[ \t]*\r?\n/gi, '')
      .replace(/```/g, '')
      .replace(/["'“”‘’`]/g, '')
      .replace(/^\s*(?:(?:positive\s+)?prompt|提示词|正向提示词)\s*[:：]\s*/i, '')
      .replace(/[\r\n]+/g, ', ')
      .replace(/\s+/g, ' ')
      .replace(/\s*,(?:\s*,)*\s*/g, ', ')
      .replace(/^[,\s]+|[,\s]+$/g, '')
      .slice(0, 1500)
  )
}

export function prefixPrompt(prefix: string, prompt: string): string {
  const body = cleanPrompt(prompt)
  return prefix.includes('{prompt}')
    ? prefix.replaceAll('{prompt}', body)
    : [prefix.trim(), body].filter(Boolean).join(', ')
}
export function rawPrompt(text: string): string {
  return text.replace(/\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 1000)
}
