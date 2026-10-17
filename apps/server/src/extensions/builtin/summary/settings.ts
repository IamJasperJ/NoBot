import type { ExtensionSettingField } from '@ai-parter/shared'
import { z } from 'zod'

const shape = z.object({
  auto: z.boolean().default(true),
  interval: z.number().int().min(0).max(500).default(20),
  tokenThreshold: z.number().int().min(0).max(100000).default(0),
  maxMessages: z.number().int().min(0).max(500).default(0),
  mode: z.enum(['transcript', 'full']).default('transcript'),
  connectionId: z.string().default(''),
  model: z.string().default(''),
  words: z.number().int().min(50).max(5000).default(300),
  maxTokens: z.number().int().min(0).max(16000).default(0),
  prompt: z
    .string()
    .default(
      '你是故事记录员。根据【已有总结】和【新的对话】，写一份更新后的剧情总结：保留仍然重要的旧信息，加入新的事实、事件、人物关系变化和未解决的线索。用第三人称、过去时，按时间顺序，不写对话原文，不评论。不超过 {{words}} 字。只输出总结本身。',
    ),
  template: z.string().default('[剧情总结：{{summary}}]'),
  position: z.enum(['after_char', 'author_note', 'depth']).default('after_char'),
  depth: z.number().int().min(0).max(100).default(4),
  role: z.enum(['system', 'user', 'assistant']).default('system'),
  skipSummarized: z.boolean().default(false),
  keepRecent: z.number().int().min(0).max(100).default(4),
})
export const defaultSettings = shape.parse({})
/** 单个字段不合法时回退该字段默认值，保留其余有效设置。 */
export function parseSettings(settings: Record<string, unknown>) {
  return shape.parse(
    Object.fromEntries(
      Object.entries(shape.shape).map(([key, schema]) => {
        const parsed = schema.safeParse(settings[key])
        return [key, parsed.success ? parsed.data : defaultSettings[key as keyof typeof defaultSettings]]
      }),
    ),
  )
}
const heading = (key: string, label: string): ExtensionSettingField => ({ key, label, type: 'heading' })
const num = (key: string, label: string, hint: string, max: number, step = 1, min = 0): ExtensionSettingField => ({
  key,
  label,
  hint,
  type: 'number',
  min,
  max,
  step,
})
const bool = (key: string, label: string, hint: string): ExtensionSettingField => ({
  key,
  label,
  hint,
  type: 'boolean',
})
const area = (key: string, label: string, hint: string): ExtensionSettingField => ({
  key,
  label,
  hint,
  type: 'textarea',
})
const select = (key: string, label: string, hint: string, pairs: [string, string][]): ExtensionSettingField => ({
  key,
  label,
  hint,
  type: 'select',
  options: pairs.map(([value, label]) => ({ value, label })),
})
export const settingsSchema: ExtensionSettingField[] = [
  heading('when', '何时总结'),
  bool('auto', '自动总结', '生成结束后检查总结条件'),
  num('interval', '新消息条数', '0 表示不按条数触发', 500),
  num('tokenThreshold', '新内容 token 数', '0 表示不按 token 触发', 100000, 100),
  num('maxMessages', '单次最多消息数', '0 表示不限，优先总结较早的消息', 500),
  heading('how', '怎么总结'),
  select('mode', '请求方式', '选择发送的上下文范围', [
    ['transcript', '只发聊天记录'],
    ['full', '完整上下文'],
  ]),
  {
    key: 'connectionId',
    label: '连接',
    hint: '留空跟随会话连接',
    type: 'select',
    options: [{ value: '', label: '跟随会话' }],
    optionsSource: 'connections',
  },
  { key: 'model', label: '模型', hint: '留空使用连接的模型', type: 'string', optionsSource: 'models' },
  num('words', '字数上限', '替换总结指令中的 {{words}}', 5000, 50, 50),
  num('maxTokens', '回复长度上限', '0 表示字数上限乘 2', 16000),
  area('prompt', '总结指令', '支持 {{words}} 字数上限'),
  heading('usage', '怎么用'),
  area('template', '注入模板', '用 {{summary}} 插入最近的总结'),
  select('position', '注入位置', '作者注释位置跟随会话的深度', [
    ['after_char', '角色设定之后'],
    ['author_note', '作者注释位置'],
    ['depth', '指定深度'],
  ]),
  { ...num('depth', '深度', '从聊天末尾倒数，0 表示末尾', 100), visibleWhen: { key: 'position', equals: 'depth' } },
  select('role', '角色', '总结注入使用的消息角色', [
    ['system', '系统'],
    ['user', '用户'],
    ['assistant', '助手'],
  ]),
  bool('skipSummarized', '跳过已总结消息', '组装时省略总结范围内的旧消息'),
  num('keepRecent', '保留最近消息数', '即使已总结也保留这些消息作为衔接', 100),
]
