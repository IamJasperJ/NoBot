import type { ExtensionSettingField } from '@ai-parter/shared'
import { z } from 'zod'
import { modes, templates } from './modes'
import { resolutionOptions } from './options'

const style = z.object({
  name: z.string().default('默认'),
  promptPrefix: z.string().default(''),
  promptSuffix: z.string().default(''),
  negativePrompt: z.string().default(''),
})
const shape = z
  .object({
    source: z.enum(['openai', 'comfy']).default('openai'),
    openaiConnectionId: z.string().default(''),
    openaiBaseUrl: z.string().default('https://api.openai.com/v1'),
    openaiApiKey: z.string().default(''),
    openaiModel: z.string().default('gpt-image-1'),
    openaiExtra: z.string().default(''),
    openaiQuality: z.enum(['auto', 'low', 'medium', 'high']).default('auto'),
    openaiImageOnly: z.boolean().default(true),
    promptConnectionId: z.string().default(''),
    promptModel: z.string().default(''),
    comfyUrl: z.string().default('http://127.0.0.1:8188'),
    comfyHeaders: z.string().default(''),
    comfyCheckpoint: z.string().default(''),
    comfySampler: z.string().default('euler_ancestral'),
    comfyScheduler: z.string().default('normal'),
    comfyVae: z.string().default(''),
    comfyDenoise: z.number().min(0).max(1).default(1),
    comfyClipSkip: z.number().int().max(-1).default(-1),
    comfySteps: z.number().int().min(1).max(1000).default(25),
    comfyCfg: z.number().min(0).max(100).default(7),
    comfyWorkflowName: z.string().default(''),
    comfyWorkflows: z.array(z.object({ name: z.string(), json: z.string() })).default([]),
    comfyCustomPlaceholders: z.array(z.object({ find: z.string(), replace: z.string() })).default([]),
    comfyTimeout: z.number().positive().max(3600).default(300),
    resolution: z.string().default('832x1216'),
    snapResolution: z.boolean().default(true),
    width: z.number().int().positive().max(8192).default(832),
    height: z.number().int().positive().max(8192).default(1216),
    styles: z.array(style).default([
      {
        name: '默认',
        promptPrefix: 'best quality, masterpiece, highly detailed',
        promptSuffix: '',
        negativePrompt: 'lowres, bad anatomy, bad hands, text, error, worst quality, watermark, blurry',
      },
    ]),
    activeStyle: z.string().default('默认'),
    modeOverrides: z
      .array(
        z.object({
          mode: z.string(),
          enabled: z.boolean().default(false),
          promptPrefix: z.string().default(''),
          promptSuffix: z.string().default(''),
          negativePrompt: z.string().default(''),
          width: z.number().int().min(0).max(8192).default(0),
          height: z.number().int().min(0).max(8192).default(0),
        }),
      )
      .default([]),
    seed: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).default(-1),
    maxConcurrent: z.number().int().min(1).max(8).default(3),
    async: z.boolean().default(true),
    toolEnabled: z.boolean().default(false),
    promptWithHistory: z.boolean().default(true),
    editBeforeGenerate: z.boolean().default(false),
    interactiveMode: z.boolean().default(false),
    multimodalCaptioning: z.boolean().default(false),
    minimalProcessing: z.boolean().default(false),
    messageTemplate: z.string().default('[{{char}} 发送了一张图片：{{prompt}}]'),
    visibleFromButton: z.boolean().default(false),
    visibleFromTool: z.boolean().default(false),
    visibleFromInteractive: z.boolean().default(false),
  })
  .catchall(z.unknown())
export type Settings = z.infer<typeof shape>
export const defaultSettings = {
  ...shape.parse({}),
  ...Object.fromEntries(Object.entries(templates).map(([k, v]) => [`tpl_${k}`, v])),
}
export const parseSettings = (settings: Record<string, unknown>) => shape.parse({ ...defaultSettings, ...settings })
const openai = { key: 'source', equals: 'openai' }
const comfy = { key: 'source', equals: 'comfy' }
const text = (
  key: string,
  label: string,
  hint: string,
  extra: Partial<Extract<ExtensionSettingField, { type: 'string' }>> = {},
): ExtensionSettingField => ({ key, label, hint, type: 'string', ...extra })
const area = (key: string, label: string, hint: string): ExtensionSettingField => ({
  key,
  label,
  hint,
  type: 'textarea',
})
const number = (key: string, label: string, hint: string, min = 0, step = 1): ExtensionSettingField => ({
  key,
  label,
  hint,
  type: 'number',
  min,
  step,
})
const bool = (key: string, label: string, hint: string): ExtensionSettingField => ({
  key,
  label,
  hint,
  type: 'boolean',
})
const select = (
  key: string,
  label: string,
  options: { value: string; label: string }[],
  optionsSource?: string,
): ExtensionSettingField => ({ key, label, type: 'select', options, optionsSource })
const heading = (key: string, label: string, defaultCollapsed = false): ExtensionSettingField => ({
  key,
  label,
  type: 'heading',
  defaultCollapsed,
})
const promptFields = [
  area('promptPrefix', '正向前缀', '支持 {prompt} 指定角色外貌和生成提示词的插入位置'),
  area('promptSuffix', '正向后缀', '放在生成提示词之后'),
  area('negativePrompt', '负面提示词', '排除不希望出现的内容'),
]
export const settingsSchema: ExtensionSettingField[] = [
  heading('interface', '图片接口'),
  select('source', '后端', [
    { value: 'openai', label: 'OpenAI 兼容接口' },
    { value: 'comfy', label: 'ComfyUI' },
  ]),
  {
    ...select('openaiConnectionId', '复用连接', [{ value: '', label: '自定义（下面填写地址和密钥）' }], 'connections'),
    visibleWhen: openai,
    hint: '仅复用地址与密钥，不切换聊天连接或使用聊天模型',
  },
  text('openaiBaseUrl', '接口地址', '包含 /v1 等接口路径', { visibleWhen: { key: 'openaiConnectionId', equals: '' } }),
  text('openaiApiKey', 'API 密钥', '图片接口的鉴权密钥', {
    secret: true,
    visibleWhen: { key: 'openaiConnectionId', equals: '' },
  }),
  text('openaiModel', '图片模型', '从端点拉取候选，也可以手填模型 ID', {
    optionsSource: 'openai/models',
    visibleWhen: openai,
  }),
  {
    ...bool('openaiImageOnly', '只显示可能的图片模型', '按名称筛选，关闭可查看端点的全部模型；始终允许手填'),
    visibleWhen: openai,
  },
  {
    ...select(
      'openaiQuality',
      'GPT Image 质量',
      ['auto', 'low', 'medium', 'high'].map((value) => ({
        value,
        label: { auto: '自动', low: '低', medium: '中', high: '高' }[value] ?? value,
      })),
    ),
    visibleWhen: openai,
    hint: '仅对 gpt-image-* 发送 quality',
  },
  { ...area('openaiExtra', '额外参数（JSON）', '高级接口参数，会合并到图片请求中'), visibleWhen: openai },
  ...[
    text('comfyUrl', 'ComfyUI 地址', '必须可由应用服务器访问'),
    {
      ...area(
        'comfyHeaders',
        '附加请求头（JSON）',
        '例如反向代理鉴权，留空不附加；示例：{"Authorization": "Bearer xxx"}',
      ),
      attachTo: 'comfyUrl',
      attachLabel: '头',
    },
    text('comfyCheckpoint', '模型文件名', '注意选择与工作流 Loader 匹配的类型', { optionsSource: 'comfy/models' }),
    text('comfySampler', '采样器', '从 KSampler 读取', { optionsSource: 'comfy/samplers' }),
    text('comfyScheduler', '调度器', '从 KSampler 读取', { optionsSource: 'comfy/schedulers' }),
    text('comfyVae', 'VAE', '留空使用工作流默认 VAE', { optionsSource: 'comfy/vaes' }),
  ].map((field) => ({ ...field, visibleWhen: comfy })),
  heading('picture', '画面与分辨率'),
  select('resolution', '基准分辨率', [...resolutionOptions, { value: 'custom', label: '自定义' }]),
  ...[
    number('width', '自定义宽度', '仅自定义分辨率生效', 1),
    number('height', '自定义高度', '仅自定义分辨率生效', 1),
  ].map((field) => ({ ...field, visibleWhen: { key: 'resolution', equals: 'custom' } })),
  bool('snapResolution', '调整后贴合预设分辨率', '横竖图对调后，尽量保持像素总数并贴合最近的预设'),
  number('seed', '种子', '-1 为随机；生成新候选时固定种子也会重新随机', -1),
  heading('stylesSection', '风格'),
  {
    key: 'styles',
    titleKey: 'name',
    label: '风格列表',
    type: 'list',
    itemFields: [text('name', '名称', '用于选择风格'), ...promptFields],
  },
  select('activeStyle', '当前风格', [], 'styles'),
  {
    key: 'modeOverrides',
    titleKey: 'mode',
    label: '按生成类型覆盖',
    type: 'list',
    hint: '启用后覆盖风格的前缀、后缀和负面；宽高同时大于零时覆盖尺寸',
    itemFields: [
      select('mode', '生成类型', [
        ...modes.map((m) => ({ value: m.key, label: m.name })),
        { value: 'tool', label: '工具' },
      ]),
      bool('enabled', '启用', '覆盖该类型的风格参数'),
      ...promptFields,
      number('width', '宽度', '0 表示继承'),
      number('height', '高度', '0 表示继承'),
    ],
  },
  heading('behavior', '行为'),
  number('maxConcurrent', '同时生成的最大数量', '超过的任务按顺序排队', 1),
  bool('async', '异步生成', '先插入占位框，完成后自动显示图片'),
  bool('editBeforeGenerate', '生成前编辑提示词', '确认完整正负提示词和参数后才提交图片任务'),
  bool(
    'minimalProcessing',
    '最少处理提示词',
    '仅规范空白，保留引号、前缀和结构化 JSON（给接受结构化提示词的 ComfyUI 工作流用）',
  ),
  area('messageTemplate', '图片消息模板', '支持 {{char}} {{user}} {{prompt}}；prompt 不含风格和角色前缀'),
  ...(['Button', 'Tool', 'Interactive'] as const).map((source) =>
    bool(
      `visibleFrom${source}`,
      `让模型看到${{ Button: '按钮', Tool: '工具', Interactive: '交互模式' }[source]}生成的图片消息`,
      '默认关闭；工具结果文字仍然进入上下文，图片说明照常保存',
    ),
  ),
  heading('interaction', '交互与工具', true),
  bool('toolEnabled', '允许模型调用 generate_image 工具', '让聊天模型在需要时发起图片生成'),
  bool('interactiveMode', '交互模式', '匹配用户的中英文要图请求，和文字回复同时生成；开启工具调用时不生效'),
  bool('promptWithHistory', '写提示词时带上聊天记录', '关闭时仅使用角色设定和本次指令'),
  bool(
    'multimodalCaptioning',
    '多模态描述头像',
    '角色、脸部和用户模式将头像发送给写提示词的模型，无头像时使用普通模板',
  ),
  select('promptConnectionId', '写提示词的连接', [{ value: '', label: '跟随当前会话的连接' }], 'connections'),
  text('promptModel', '写提示词的模型', '留空使用该连接的默认模型；跟随会话时请先选择会话', {
    optionsSource: 'prompt/models',
  }),
  heading('templates', '提示词模板', true),
  ...modes
    .filter((m) => m.key in templates)
    .map((m) =>
      area(`tpl_${m.key}`, m.name, '要求输出英文关键词；支持 {{char}} {{user}} {{input}}，自由模式可写 {{charPrefix}}'),
    ),
  heading('comfyAdvanced', 'ComfyUI 高级', true),
  ...[
    select(
      'comfyWorkflowName',
      '当前工作流',
      [
        { value: '', label: '内置默认' },
        { value: 'avatar', label: '角色头像图生图' },
      ],
      'comfy/workflows',
    ),
    {
      key: 'comfyWorkflows',
      titleKey: 'name',
      label: '自定义工作流',
      type: 'list' as const,
      itemFields: [
        text('name', '名称', '选择工作流时显示'),
        area('json', 'API 工作流 JSON', '从 ComfyUI 导出的 API 格式对象'),
      ],
    },
    number('comfySteps', '步数', '仅工作流引用 %steps% 时生效', 1),
    number('comfyCfg', 'CFG', '仅工作流引用 %scale% 时生效', 0, 0.5),
    number('comfyDenoise', '去噪强度', '0～1，仅工作流引用 %denoise% 时生效', 0, 0.05),
    number('comfyClipSkip', 'CLIP 跳层', '负整数，仅工作流引用 %clip_skip% 时生效', -99),
    number('comfyTimeout', '超时（秒）', '超过后中止当前任务', 1),
    {
      key: 'comfyCustomPlaceholders',
      titleKey: 'find',
      label: '自定义占位符',
      type: 'list' as const,
      itemFields: [text('find', '查找', '填写名称或 %名称%'), text('replace', '替换', '支持 {{char}} {{user}} 宏')],
    },
  ].map((field) => ({ ...field, visibleWhen: comfy })),
]
