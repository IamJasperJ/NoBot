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
  '忽略之前的格式要求。请把下面这段内容所描述的画面写成 AI 绘图描述（按位置、人物数量性别、相对位置、主要动作、外貌表情、动作的顺序，只描述一个静态画面）：\n{{input}}'
export const templates: Partial<Record<Mode, string>> = {
  character:
    '忽略之前的格式要求。请为 {{char}} 写一份用于 AI 绘图的外貌描述，按顺序包含：人数与性别（如 1girl / 1boy）、种族、年龄感、发型发色、眼睛、体型、服装、配饰、姿势、表情、背景简述。以 full body 开头。',
  face: '忽略之前的格式要求。请为 {{char}} 写一份脸部特写的 AI 绘图描述，按顺序包含：人数与性别、种族、年龄感、发型发色、眼睛、脸部特征、表情、头部配饰。以 close-up portrait, face focus 开头。',
  user: '忽略之前的格式要求。请为 {{user}}（用户扮演的角色）写一份用于 AI 绘图的外貌描述，按顺序包含：人数与性别、种族、年龄感、发型发色、眼睛、体型、服装、姿势、表情。以 full body 开头。如果设定里没有足够的外貌信息，就根据已有信息合理推断。',
  scene:
    '忽略之前的格式要求。请把当前故事正在发生的场景写成 AI 绘图描述：出场人物（数量、性别、外貌要点、动作）、地点、时间、光线、天气、氛围、镜头角度。',
  last,
  message: last,
  background:
    '忽略之前的格式要求。请为当前故事所在的地点写一份背景画面的 AI 绘图描述：只写环境（地点、建筑或自然景观、时间、光线、天气、氛围），画面里绝对不能出现任何人物。以 scenery, no humans 开头。',
  free: '忽略之前的格式要求。请把下面的画面描述扩写成 AI 绘图描述：\n{{input}}',
}
export const templateEnding =
  '只输出一行用英文逗号分隔的关键词和短语，不要写完整句子，不要解释，不要加引号或任何前缀。只描述静态画面里能看到的东西，不写性格、声音、气味、心理活动。'

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
