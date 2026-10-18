/**
 * 模型 API 提供方目录（对照酒馆的 Chat Completion Source，并把它 Text Completion 里能走 OpenAI 兼容接口的本地后端也列进来）。
 *
 * 每个提供方属于一种协议（protocol），后端按协议选择适配器：
 *   - openai：OpenAI 兼容的 /chat/completions。绝大多数提供方都是这种，只是地址、拉模型方式和个别怪癖不同
 *   - anthropic：Claude 原生 Messages API
 *   - google：Gemini（Google AI Studio）原生 generateContent
 *   - vertex：Vertex AI 上的 Gemini，请求体和 google 相同，鉴权和地址不同
 *   - azure：Azure OpenAI，按部署名拼地址、用 api-key 请求头
 *
 * 请求体在系统内部统一用 OpenAI 格式（也是记进日志的格式），由适配器在发送前转换成各家的原生格式。
 * 前端用这份目录渲染「提供方」下拉、预填地址、显示专用选项；后端用它决定协议和默认值。
 */

export const API_PROTOCOLS = ['openai', 'anthropic', 'google', 'vertex', 'azure'] as const
export type ApiProtocol = (typeof API_PROTOCOLS)[number]

/** 提供方专用的选项字段（存进连接的 options 里） */
export interface ProviderOptionField {
  key: string
  /** 中文原文，界面用 t() 翻译 */
  label: string
  hint?: string
  type: 'string' | 'select'
  /** select 的候选；label 同样是中文原文 */
  choices?: { value: string; label: string }[]
  default?: string
  placeholder?: string
  required?: boolean
  /** 只在另一个选项等于某值时显示，例如 Vertex 的项目 ID 只在「服务账号」模式下需要 */
  when?: { key: string; equals: string }
}

export interface ProviderInfo {
  id: string
  /** 品牌名，不翻译 */
  label: string
  protocol: ApiProtocol
  /** 可选的地址，第一个是默认值；label 是中文原文（如「国际站」「国内站」）。为空表示必须由用户填写 */
  baseUrls: { url: string; label?: string }[]
  /** 是否必须填 Key（本地后端、匿名 Pollinations 不需要） */
  keyRequired: boolean
  /** Key 输入框的说明，例如 Vertex 服务账号模式要粘贴整份 JSON；中文原文 */
  keyHint?: string
  /** list：调接口拉模型；static：用下面的固定列表（对方没有模型列表接口） */
  models: 'list' | 'static'
  staticModels?: string[]
  options?: ProviderOptionField[]
  /** 分组，用于下拉里分段显示：cloud 云端服务；local 本地 / 自部署；custom 自定义 */
  group: 'cloud' | 'local' | 'custom'
  docsUrl?: string
}

const local = (id: string, label: string, url: string, docsUrl?: string): ProviderInfo => ({
  id,
  label,
  protocol: 'openai',
  baseUrls: [{ url }],
  keyRequired: false,
  models: 'list',
  group: 'local',
  ...(docsUrl ? { docsUrl } : {}),
})

const cloud = (
  id: string,
  label: string,
  baseUrls: ProviderInfo['baseUrls'],
  extra: Partial<ProviderInfo> = {},
): ProviderInfo => ({ id, label, protocol: 'openai', baseUrls, keyRequired: true, models: 'list', group: 'cloud', ...extra })

export const PROVIDERS: ProviderInfo[] = [
  // ── 原生协议 ──
  cloud('openai', 'OpenAI', [{ url: 'https://api.openai.com/v1' }]),
  cloud('claude', 'Anthropic Claude', [{ url: 'https://api.anthropic.com/v1' }], { protocol: 'anthropic' }),
  cloud('gemini', 'Google AI Studio (Gemini)', [{ url: 'https://generativelanguage.googleapis.com' }], {
    protocol: 'google',
  }),
  cloud('vertexai', 'Google Vertex AI', [{ url: 'https://aiplatform.googleapis.com' }], {
    protocol: 'vertex',
    keyHint: '快速模式填 API Key；服务账号模式粘贴整份服务账号 JSON',
    options: [
      {
        key: 'authMode',
        label: '鉴权方式',
        type: 'select',
        default: 'express',
        choices: [
          { value: 'express', label: '快速模式（API Key）' },
          { value: 'service_account', label: '服务账号（JSON）' },
        ],
      },
      { key: 'region', label: '区域', type: 'string', default: 'global', placeholder: 'global / us-central1' },
      {
        key: 'projectId',
        label: '项目 ID',
        type: 'string',
        hint: '留空时从服务账号 JSON 里读取',
        when: { key: 'authMode', equals: 'service_account' },
      },
    ],
  }),
  {
    id: 'azure_openai',
    label: 'Azure OpenAI',
    protocol: 'azure',
    baseUrls: [],
    keyRequired: true,
    models: 'static',
    staticModels: [],
    group: 'cloud',
    options: [
      { key: 'deployment', label: '部署名', type: 'string', required: true },
      { key: 'apiVersion', label: 'API 版本', type: 'string', default: '2024-10-21' },
    ],
  },
  // ── OpenAI 兼容的云服务 ──
  cloud('openrouter', 'OpenRouter', [{ url: 'https://openrouter.ai/api/v1' }]),
  cloud('deepseek', 'DeepSeek', [{ url: 'https://api.deepseek.com/beta' }]),
  cloud('mistralai', 'Mistral AI', [{ url: 'https://api.mistral.ai/v1' }]),
  cloud('cohere', 'Cohere', [{ url: 'https://api.cohere.ai/compatibility/v1' }]),
  cloud('ai21', 'AI21', [{ url: 'https://api.ai21.com/studio/v1' }], {
    models: 'static',
    staticModels: ['jamba-large', 'jamba-mini'],
  }),
  cloud('perplexity', 'Perplexity', [{ url: 'https://api.perplexity.ai' }], {
    models: 'static',
    staticModels: ['sonar', 'sonar-pro', 'sonar-reasoning', 'sonar-reasoning-pro', 'sonar-deep-research'],
  }),
  cloud('groq', 'Groq', [{ url: 'https://api.groq.com/openai/v1' }]),
  cloud('xai', 'xAI (Grok)', [{ url: 'https://api.x.ai/v1' }]),
  cloud('moonshot', 'Moonshot (Kimi)', [
    { url: 'https://api.moonshot.ai/v1', label: '国际站' },
    { url: 'https://api.moonshot.cn/v1', label: '国内站' },
  ]),
  cloud('zai', 'Z.AI / 智谱 GLM', [
    { url: 'https://api.z.ai/api/paas/v4', label: '国际站' },
    { url: 'https://api.z.ai/api/coding/paas/v4', label: '国际站（编程套餐）' },
    { url: 'https://open.bigmodel.cn/api/paas/v4', label: '国内站' },
  ]),
  cloud('siliconflow', 'SiliconFlow 硅基流动', [
    { url: 'https://api.siliconflow.cn/v1', label: '国内站' },
    { url: 'https://api.siliconflow.com/v1', label: '国际站' },
  ]),
  cloud('minimax', 'MiniMax', [
    { url: 'https://api.minimaxi.com/v1', label: '国内站' },
    { url: 'https://api.minimax.io/v1', label: '国际站' },
  ]),
  cloud('fireworks', 'Fireworks AI', [{ url: 'https://api.fireworks.ai/inference/v1' }]),
  cloud('togetherai', 'Together AI', [{ url: 'https://api.together.xyz/v1' }]),
  cloud('chutes', 'Chutes', [{ url: 'https://llm.chutes.ai/v1' }]),
  cloud('electronhub', 'Electron Hub', [{ url: 'https://api.electronhub.ai/v1' }]),
  cloud('nanogpt', 'NanoGPT', [{ url: 'https://nano-gpt.com/api/v1' }]),
  cloud('aimlapi', 'AI/ML API', [{ url: 'https://api.aimlapi.com/v1' }]),
  cloud('cometapi', 'CometAPI', [{ url: 'https://api.cometapi.com/v1' }]),
  cloud('featherless', 'Featherless', [{ url: 'https://api.featherless.ai/v1' }]),
  cloud('infermaticai', 'Infermatic', [{ url: 'https://api.totalgpt.ai/v1' }]),
  cloud('huggingface', 'Hugging Face', [{ url: 'https://router.huggingface.co/v1' }]),
  cloud(
    'pollinations',
    'Pollinations',
    [
      { url: 'https://gen.pollinations.ai/v1', label: '带 Key' },
      { url: 'https://text.pollinations.ai/v1', label: '匿名' },
    ],
    { keyRequired: false },
  ),
  cloud('workers_ai', 'Cloudflare Workers AI', [{ url: 'https://api.cloudflare.com/client/v4/accounts' }], {
    options: [{ key: 'accountId', label: '账户 ID', type: 'string', required: true }],
  }),
  // ── 本地 / 自部署（都用它们的 OpenAI 兼容接口） ──
  local('ollama', 'Ollama', 'http://localhost:11434/v1'),
  local('lmstudio', 'LM Studio', 'http://localhost:1234/v1'),
  local('koboldcpp', 'KoboldCpp', 'http://localhost:5001/v1'),
  local('llamacpp', 'llama.cpp', 'http://localhost:8080/v1'),
  local('vllm', 'vLLM', 'http://localhost:8000/v1'),
  local('aphrodite', 'Aphrodite', 'http://localhost:2242/v1'),
  local('tabby', 'TabbyAPI', 'http://localhost:5000/v1'),
  local('ooba', 'Text Generation WebUI', 'http://localhost:5000/v1'),
  // ── 自定义 ──
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    protocol: 'openai',
    baseUrls: [],
    keyRequired: false,
    models: 'list',
    group: 'custom',
  },
]

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id) as [string, ...string[]]

/** 找不到时回退到 custom，保证旧数据和手填的值都能用 */
export function providerInfo(id: string | undefined): ProviderInfo {
  return PROVIDERS.find((p) => p.id === id) ?? (PROVIDERS.find((p) => p.id === 'custom') as ProviderInfo)
}

/** 合并提供方选项的默认值和已保存的值 */
export function providerOptions(id: string | undefined, saved: Record<string, string> = {}): Record<string, string> {
  const defaults = Object.fromEntries(
    (providerInfo(id).options ?? []).filter((o) => o.default !== undefined).map((o) => [o.key, o.default as string]),
  )
  return { ...defaults, ...saved }
}
