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
  'Ignore previous format requirements. Turn the following content into an AI image prompt describing a single still image. Include location, number and gender of people, relative positions, main action, appearance, expression, and pose, in that order:\n{{input}}'
export const templates: Partial<Record<Mode, string>> = {
  character:
    'Ignore previous format requirements. Write an AI image prompt describing {{char}}, in this order: number and gender (e.g. 1girl / 1boy), species, apparent age, hairstyle and hair color, eyes, build, clothing, accessories, pose, expression, and brief background. Start with full body.',
  face: 'Ignore previous format requirements. Write a close-up AI image prompt for {{char}}, in this order: number and gender, species, apparent age, hairstyle and hair color, eyes, facial features, expression, and head accessories. Start with close-up portrait, face focus.',
  user: 'Ignore previous format requirements. Write an AI image prompt describing {{user}} (the character played by the user), in this order: number and gender, species, apparent age, hairstyle and hair color, eyes, build, clothing, pose, and expression. Start with full body. If appearance details are insufficient, infer plausible details from the available information.',
  scene:
    'Ignore previous format requirements. Write an AI image prompt for the current story scene: people present (number, gender, key appearance details, actions), location, time, lighting, weather, mood, and camera angle.',
  last,
  message: last,
  background:
    'Ignore previous format requirements. Write an AI image prompt for the current story location. Describe only the environment (location, architecture or landscape, time, lighting, weather, mood). No people may appear. Start with scenery, no humans.',
  free: 'Ignore previous format requirements. Expand the following scene description into an AI image prompt:\n{{input}}',
}
export const templateEnding =
  'Output only one line of comma-separated English keywords and phrases. Do not use full sentences, explanations, quotes, or prefixes. Describe only visible elements in a still image, excluding personality, sounds, smells, and thoughts.'

export function replaceTemplate(template: string, values: { char: string; user: string; input: string }): string {
  return template.replace(/{{(char|user|input)}}/g, (_, key: keyof typeof values) => values[key])
}

export function cleanPrompt(text: string, minimal = false): string {
  if (minimal) return text.replace(/\s+/g, ' ').trim()
  return text
    .replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/```[a-z0-9_-]*[ \t]*\r?\n/gi, '')
    .replace(/```/g, '')
    .replace(/["'“”‘’`]/g, '')
    .replace(/^\s*(?:(?:positive\s+)?prompt|提示词|正向提示词)\s*[:：]\s*/i, '')
    .replace(/[\r\n]+/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/\s*,(?:\s*,)*\s*/g, ', ')
    .replace(/^[,\s]+|[,\s]+$/g, '')
    .slice(0, 1500)
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
