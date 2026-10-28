import type { ExtensionSettingField } from '@nobot/shared'
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
    spriteMatting: z.enum(['algorithm', 'native', 'model']).default('algorithm'),
    spriteBackdrop: z.enum(['green', 'white']).default('green'),
    mattingModel: z.string().default(''),
    mattingModelUrl: z.string().default('https://huggingface.co/skytnt/anime-seg/resolve/main/isnetis.onnx'),
    mattingRegistry: z.string().default(''),
    source: z.enum(['openai', 'comfy', 'a1111', 'openrouter']).default('openai'),
    openaiConnectionId: z.string().default(''),
    openaiBaseUrl: z.string().default('https://api.openai.com/v1'),
    openaiApiKey: z.string().default(''),
    openaiModel: z.string().default('gpt-image-1'),
    openaiExtra: z.string().default(''),
    openaiQuality: z.enum(['auto', 'low', 'medium', 'high']).default('auto'),
    openaiHeaders: z.string().default(''),
    /** 出图走哪个接口：auto 按模型名判断并在报错时自动换另一个；images = /images/generations；chat = /chat/completions */
    openaiApiType: z.enum(['auto', 'images', 'chat']).default('auto'),
    /** 按模型修正尺寸：默认关闭，原样发送设置的分辨率 */
    openaiSnapSize: z.boolean().default(false),
    openrouterConnectionId: z.string().default(''),
    openrouterBaseUrl: z.string().default('https://openrouter.ai/api/v1'),
    openrouterApiKey: z.string().default(''),
    openrouterModel: z.string().default(''),
    openrouterHeaders: z.string().default(''),
    a1111Url: z.string().default('http://127.0.0.1:7860'),
    a1111Auth: z.string().default(''),
    a1111Model: z.string().default(''),
    a1111Sampler: z.string().default('Euler a'),
    a1111Scheduler: z.string().default(''),
    a1111Vae: z.string().default(''),
    a1111Steps: z.number().int().min(1).max(1000).default(25),
    a1111Cfg: z.number().min(0).max(100).default(7),
    a1111ClipSkip: z.number().int().min(1).max(12).default(1),
    a1111Hires: z.boolean().default(false),
    a1111Upscaler: z.string().default('Latent'),
    a1111HiresScale: z.number().min(1).max(8).default(2),
    a1111HiresSteps: z.number().int().min(0).max(1000).default(0),
    a1111Denoise: z.number().min(0).max(1).default(0.7),
    a1111RestoreFaces: z.boolean().default(false),
    a1111ADetailer: z.boolean().default(false),
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
    promptStyle: z.enum(['auto', 'tags', 'natural']).default('tags'),
    refineModelPrompts: z.boolean().default(true),
    freeExtend: z.boolean().default(false),
    toolPrompt: z.string().default(''),
    promptWithHistory: z.boolean().default(true),
    editBeforeGenerate: z.boolean().default(false),
    interactiveMode: z.boolean().default(false),
    multimodalCaptioning: z.boolean().default(false),
    minimalProcessing: z.boolean().default(false),
    messageTemplate: z.string().default('[{{char}} sent an image: {{prompt}}]'),
    visibleFromButton: z.boolean().default(false),
    visibleFromTool: z.boolean().default(false),
    seeGeneratedImages: z.boolean().default(false),
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
/** 带滑块的半宽数字（步数、CFG 这类两两并排显示） */
const slider = (key: string, label: string, min: number, max: number, step: number): ExtensionSettingField => ({
  key,
  label,
  type: 'number',
  min,
  max,
  step,
  slider: true,
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
    { value: 'a1111', label: 'A1111 / Forge' },
    { value: 'openrouter', label: 'OpenRouter' },
  ]),
  {
    ...select('openaiConnectionId', '复用连接', [{ value: '', label: '自定义（下面填写地址和密钥）' }], 'connections'),
    visibleWhen: openai,
    hint: '仅复用地址与密钥，不切换聊天连接或使用聊天模型',
  },
  {
    ...area(
      'openaiHeaders',
      '额外请求头（JSON）',
      '每个图片请求都会带上，例如反向代理鉴权；示例：{"X-Api-Key": "xxx"}',
    ),
    attachTo: 'openaiConnectionId',
    attachLabel: '额外请求头',
    visibleWhen: openai,
  },
  text('openaiBaseUrl', '接口地址', '包含 /v1 等接口路径', {
    visibleWhen: [openai, { key: 'openaiConnectionId', equals: '' }],
  }),
  text('openaiApiKey', 'API 密钥', '图片接口的鉴权密钥', {
    secret: true,
    visibleWhen: [openai, { key: 'openaiConnectionId', equals: '' }],
  }),
  text('openaiModel', '图片模型', '可以从端点拉取全部模型（图片模型排在前面），也可以直接手填任意模型 ID', {
    optionsSource: 'openai/models',
    visibleWhen: openai,
  }),
  {
    ...select('openaiApiType', '接口类型', [
      { value: 'auto', label: '自动（按模型判断，失败时换另一个）' },
      { value: 'images', label: '图片接口 /images/generations（gpt-image、DALL·E）' },
      { value: 'chat', label: '聊天接口 /chat/completions（Gemini 图片模型、nano-banana 等）' },
    ]),
    visibleWhen: openai,
    hint: '有的模型（比如 Gemini 图片模型）只能通过聊天接口出图，图片包含在回复里',
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
    hint: '选了就随请求发送 quality；「自动」时不发送',
  },
  {
    ...bool(
      'openaiSnapSize',
      '按模型修正尺寸',
      '默认原样发送设置的分辨率。开启后 gpt-image 贴合 1024×1024 / 1536×1024 / 1024×1536，DALL·E 贴合它支持的尺寸',
    ),
    visibleWhen: openai,
  },
  { ...area('openaiExtra', '额外参数（JSON）', '高级接口参数，会合并到图片请求中'), visibleWhen: openai },
  ...[
    text('comfyUrl', 'ComfyUI 地址', '必须可由应用服务器访问'),
    {
      ...area(
        'comfyHeaders',
        '额外请求头（JSON）',
        '例如反向代理鉴权，留空不附加；示例：{"Authorization": "Bearer xxx"}',
      ),
      attachTo: 'comfyUrl',
      attachLabel: '额外请求头',
    },
    // 工作流管理（下拉 + 编辑 / 新建 / 重命名 / 删除，编辑器里显示占位符使用情况），由前端自定义控件渲染
    {
      key: 'comfyWorkflowName',
      label: '工作流',
      type: 'custom' as const,
      hint: '编辑器里可以粘贴从 ComfyUI 导出的 API 格式工作流，并查看用到了哪些占位符',
    },
    text('comfyCheckpoint', '模型', '与工作流的 Loader 类型匹配', { optionsSource: 'comfy/models' }),
    text('comfyVae', 'VAE', '留空使用工作流默认', { optionsSource: 'comfy/vaes' }),
    text('comfySampler', '采样器', '', { optionsSource: 'comfy/samplers' }),
    text('comfyScheduler', '调度器', '', { optionsSource: 'comfy/schedulers' }),
    slider('comfySteps', '采样步数', 1, 150, 1),
    slider('comfyCfg', 'CFG', 1, 30, 0.5),
    slider('comfyDenoise', '去噪强度', 0, 1, 0.05),
    slider('comfyClipSkip', 'CLIP 跳层', -12, -1, 1),
    number('comfyTimeout', '超时（秒）', '超过后中止当前任务', 1),
  ].map((field) => ({ ...field, visibleWhen: comfy })),
  ...[
    select('openrouterConnectionId', '复用连接', [{ value: '', label: '自定义（下面填写地址和密钥）' }], 'connections'),
    text('openrouterBaseUrl', '接口地址', '包含 /v1 等接口路径'),
    text('openrouterApiKey', 'API 密钥', '图片接口的鉴权密钥', { secret: true }),
    text('openrouterModel', '图片模型', '仅列出支持图片输出的模型', { optionsSource: 'openrouter/models' }),
    area('openrouterHeaders', '额外请求头（JSON）', '复用连接时覆盖同名请求头'),
  ].map((field) => ({
    ...field,
    visibleWhen: ['openrouterBaseUrl', 'openrouterApiKey'].includes(field.key)
      ? [
          { key: 'source', equals: 'openrouter' },
          { key: 'openrouterConnectionId', equals: '' },
        ]
      : { key: 'source', equals: 'openrouter' },
  })),
  ...[
    text('a1111Url', 'A1111 / Forge 地址', '必须可由应用服务器访问'),
    text('a1111Auth', 'Basic Auth', '可选，格式为用户名:密码', { secret: true }),
    text('a1111Model', '模型', '', { optionsSource: 'a1111/models' }),
    text('a1111Sampler', '采样器', '', { optionsSource: 'a1111/samplers' }),
    text('a1111Scheduler', '调度器', '', { optionsSource: 'a1111/schedulers' }),
    text('a1111Vae', 'VAE', '留空使用后端默认', { optionsSource: 'a1111/vaes' }),
    slider('a1111Steps', '采样步数', 1, 150, 1),
    slider('a1111Cfg', 'CFG', 1, 30, 0.5),
    slider('a1111ClipSkip', 'CLIP 跳层', 1, 12, 1),
    bool('a1111Hires', '高分修复', '先生成低分辨率图片再放大重绘'),
    text('a1111Upscaler', '放大器', '', { optionsSource: 'a1111/upscalers' }),
    slider('a1111HiresScale', '放大倍数', 1, 8, 0.1),
    slider('a1111HiresSteps', '第二遍步数', 0, 150, 1),
    slider('a1111Denoise', '重绘幅度', 0, 1, 0.05),
    bool('a1111RestoreFaces', '面部修复', '使用后端的面部修复功能'),
    bool('a1111ADetailer', 'ADetailer', '使用 ADetailer 自动修复脸部'),
  ].map((field) => ({
    ...field,
    visibleWhen: [
      { key: 'source', equals: 'a1111' },
      ...(['a1111Upscaler', 'a1111HiresScale', 'a1111HiresSteps', 'a1111Denoise'].includes(field.key)
        ? [{ key: 'a1111Hires', equals: true }]
        : []),
      ...(field.key === 'a1111Scheduler' ? [{ key: 'a1111HasSchedulers', equals: true }] : []),
      ...(field.key === 'a1111ADetailer' ? [{ key: 'a1111HasADetailer', equals: true }] : []),
    ],
  })),
  heading('spriteMattingSection', '立绘抠图'),
  {
    ...select('spriteMatting', '抠图模式', [
      { value: 'algorithm', label: '算法抠图' },
      { value: 'native', label: '出图服务出透明图' },
      { value: 'model', label: '本地模型抠图' },
    ]),
    hint: '算法抠图：不需要下载，配合绿幕背景最干净。出图服务出透明图：OpenAI 的 gpt-image 模型原生支持；ComfyUI 需要在工作流里安装抠图节点（如 ComfyUI-RMBG 或 BiRefNet），并用 Join Image with Alpha 输出带透明通道的 PNG；A1111、OpenRouter 等不支持的后端会自动退回算法抠图。本地模型抠图：效果最好，选择后需下载约 170 MB 的模型和约 90 MB 的运行时。',
  },
  {
    ...select('spriteBackdrop', '生成时的背景色', [
      { value: 'green', label: '绿幕（推荐）' },
      { value: 'white', label: '白底' },
    ]),
    hint: '绿幕和白衣服、白头发不会混淆；少数模型会把绿色带进画面，遇到时换回白底',
    visibleWhen: { key: 'spriteMatting', equals: 'algorithm' },
  },
  { key: 'mattingModel', label: '抠图模型', type: 'custom', visibleWhen: { key: 'spriteMatting', equals: 'model' } },
  text('mattingModelUrl', '抠图模型下载地址', '国内可以换成 hf-mirror.com 的同名地址', {
    visibleWhen: { key: 'spriteMatting', equals: 'model' },
  }),
  text('mattingRegistry', 'npm 镜像地址', '留空使用默认源', { visibleWhen: { key: 'spriteMatting', equals: 'model' } }),
  heading('picture', '画面与分辨率'),
  select('resolution', '基准分辨率', [...resolutionOptions, { value: 'custom', label: '自定义' }]),
  ...[number('width', '宽度', '', 64, 64), number('height', '高度', '', 64, 64)].map((field) => ({
    ...field,
    visibleWhen: { key: 'resolution', equals: 'custom' },
  })),
  bool('snapResolution', '调整后贴合预设分辨率', '横竖图对调后，尽量保持像素总数并贴合最近的预设'),
  number('seed', '种子', '-1 为随机；生成新候选时固定种子也会重新随机', -1),
  heading('stylesSection', '风格'),
  // 风格管理（下拉 + 保存 / 重命名 / 删除，下面直接编辑当前风格的前缀、后缀、负面），由前端自定义控件渲染
  { key: 'activeStyle', label: '风格', type: 'custom', hint: '前缀里可以写 {prompt} 指定生成提示词插入的位置' },
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
  bool(
    'seeGeneratedImages',
    '让角色看到生成的图片',
    '默认关闭；开启后工具生成的成品图片按生成预设的工具图片限制发送给模型',
  ),
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
  {
    ...select('promptStyle', '提示词格式', [
      { value: 'tags', label: '短标签' },
      { value: 'natural', label: '自然语言' },
      { value: 'auto', label: '自动' },
    ]),
    hint: '短标签（Danbooru 风格）适合 SD、SDXL、Illustrious、Pony；自然语言适合 Flux、Z-Image、Qwen-Image、GPT Image 和 Gemini；自动按图片后端与工作流选择',
  },
  bool('refineModelPrompts', '润色模型的生图提示词', '工具调用时先用提示词模型改写描述，失败时使用原文'),
  bool('freeExtend', '自由描述由模型扩写', '关闭时直接使用输入的绘图提示词，与酒馆自由模式一致'),
  heading('templates', '提示词模板', true),
  area('toolPrompt', '工具绘图提示词说明', '指导聊天模型编写工具调用中的绘图描述；留空使用内置说明'),
  ...modes
    .filter((m) => m.key in templates)
    .map((m) =>
      area(
        `tpl_${m.key}`,
        m.name,
        '支持 {{char}} {{user}} {{input}} 和酒馆的 {0}，自由模式可写 {{charPrefix}}；未写输入占位符时仍会附上本次描述',
      ),
    ),
]
