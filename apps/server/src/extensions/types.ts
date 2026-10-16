import type { BuildInput } from '@ai-parter/core'
import type {
  AttachmentDTO,
  BackgroundDTO,
  CharacterDTO,
  ChatDTO,
  ChatMessage,
  ExtensionSettingField,
  MessageDTO,
  MessageMeta,
  MessageRole,
} from '@ai-parter/shared'
import type { Context, Hono } from 'hono'
import type { ToolDefinition } from '../tools'

/**
 * 扩展系统（v2）。一个扩展可以同时有后端和前端两部分。
 *
 * 第三方扩展放在 data/extensions/<目录>/，目录结构：
 *   manifest.json   必需：{ id, name, version, description, author?, server?, client?, style? }
 *   server.ts       可选（manifest.server 指定文件名）：后端部分，默认导出 defineExtension({...})
 *   client.js       可选（manifest.client 指定文件名）：前端部分，浏览器里加载的 ES 模块，
 *                   默认导出 activate(api)，api 的类型见 apps/web/src/extensions/types.ts
 *   style.css       可选（manifest.style 指定文件名）：自动注入页面的样式
 * 兼容旧写法：没有 manifest.json、只有 index.ts 的目录，当作只有后端部分的扩展。
 *
 * 注意：扩展代码直接在后端进程和浏览器里运行，能做任何事，只安装你信任的扩展。
 * 完整示例见 examples/extensions/hello-world。
 */

export interface ExtensionManifest {
  id: string
  name: string
  version: string
  description: string
  author?: string
  /** 后端入口文件（相对扩展目录） */
  server?: string
  /** 前端入口文件（ES 模块，浏览器直接加载，不经过打包） */
  client?: string
  /** 样式文件 */
  style?: string
}

/** 每个扩展自己的持久化存储（存在 settings 表里，键为 extdata:<扩展 id>:<key>） */
export interface ExtensionStorage {
  get<T = unknown>(key: string): T | undefined
  set(key: string, value: unknown): void
  delete(key: string): void
}

/** 扩展通过宿主复用当前会话的生成、附件和消息能力。 */
export interface ExtensionHost {
  listGeneratedImages(
    characterId: string,
  ): { chatId: string; messageId: string; image: AttachmentDTO; prompt: string; createdAt: number }[]
  getCharacter(id: string): CharacterDTO
  /** 浅合并角色扩展数据，保留其他扩展的键。 */
  updateCharacterExtensions(id: string, patch: Record<string, unknown>): CharacterDTO
  readAvatar(kind: 'character' | 'persona', id: string): Promise<Uint8Array | null>
  /** 静默组装当前会话并生成纯文本，不保存消息；includeHistory 默认启用。 */
  quietPrompt(opts: {
    chatId: string
    instruction: string
    speakerId?: string
    role?: 'system' | 'user'
    includeHistory?: boolean
    maxTokens?: number
    connectionId?: string
    model?: string
    avatar?: Uint8Array
    signal?: AbortSignal
  }): Promise<string>
  saveImage(bytes: Uint8Array): Promise<AttachmentDTO>
  saveBackground(bytes: Uint8Array, opts: { name: string; source: 'upload' | 'generated' }): Promise<BackgroundDTO>
  setChatBackground(chatId: string, backgroundId: string | null): void
  /** 追加消息并切换叶子；生成期间拒绝追加。 */
  appendMessage(
    chatId: string,
    message: { role: MessageRole; content: string; speakerId?: string | null; meta?: MessageMeta },
  ): MessageDTO
  /** 浅合并元数据，数组整体替换，并发出 message:updated。 */
  updateMessageMeta(messageId: string, patch: Partial<MessageMeta>): MessageDTO
  getChatInfo(
    chatId: string,
    limit?: number,
  ): {
    chat: ChatDTO
    characters: {
      id: string
      name: string
      description: string
      personality: string
      scenario: string
      muted: boolean
      extensions: Record<string, unknown>
      avatarUrl: string | null
    }[]
    persona: { id?: string; name: string; description: string; avatarUrl: string | null }
    messages: MessageDTO[]
  }
  /** 每 300ms 检查文本生成状态，空闲后返回；超过 timeoutMs 毫秒抛出超时错误。 */
  waitIdle(chatId: string, timeoutMs: number): Promise<void>
  isGenerating(chatId: string): boolean
  log(entry: {
    chatId?: string | null
    kind: 'extension' | 'image'
    status: 'ok' | 'error'
    model?: string | null
    durationMs?: number
    summary: string
    request?: unknown
    response?: unknown
  }): void
}

export interface ExtensionContext {
  host: ExtensionHost
  /** 这个扩展当前的设置（已合并默认值） */
  settings: Record<string, unknown>
  /** 当前会话 id；在非会话场景（自定义接口、全局事件）里为空字符串 */
  chatId: string
  storage: ExtensionStorage
}

/** 后端事件：扩展可以订阅，做记录、统计、同步等事情。事件处理出错不影响主流程 */
export type ServerEvent =
  | { type: 'message:saved'; message: MessageDTO }
  | { type: 'message:updated'; message: MessageDTO }
  | { type: 'generation:complete'; chatId: string }
  | { type: 'chat:created'; chatId: string }

export interface ExtensionHooks {
  /** 组装 Prompt 之前：可以修改组装输入（比如给角色描述追加内容），返回新的输入 */
  beforePrompt?: (input: BuildInput, ctx: ExtensionContext) => BuildInput
  /** 组装 Prompt 之后、发送之前：可以修改最终的 messages（不影响已保存的聊天记录） */
  afterPrompt?: (messages: ChatMessage[], ctx: ExtensionContext) => ChatMessage[]
  /** 用户消息入库之前 */
  transformInput?: (text: string, ctx: ExtensionContext) => string
  /** 角色回复生成完、入库之前 */
  transformOutput?: (text: string, ctx: ExtensionContext) => string
  /** 订阅后端事件 */
  onEvent?: (event: ServerEvent, ctx: ExtensionContext) => void | Promise<void>
}

export interface Extension {
  id: string
  name: string
  description: string
  version: string
  /** 没有用户设置过时是否启用（内置扩展默认启用，第三方默认关闭） */
  enabledByDefault?: boolean
  settingsSchema?: ExtensionSettingField[]
  defaultSettings?: Record<string, unknown>
  /** 宏：名字（小写）→ 处理函数，参数是 {{名字::参数}} 里 :: 之后的部分 */
  macros?: Record<string, (arg: string, ctx: ExtensionContext) => string>
  tools?: ToolDefinition[] | ((ctx: ExtensionContext) => ToolDefinition[])
  hooks?: ExtensionHooks
  /**
   * 自定义后端接口：在传入的 Hono 子应用上注册路由，挂载在 /api/ext/<扩展 id>/ 下。
   * 例如 app.get('/ping', (c) => c.json({ ok: true })) → GET /api/ext/<id>/ping。
   * 扩展被停用时这些接口返回 404。
   * 设置项 optionsSource 对应 POST /api/ext/<id>/<optionsSource>，请求体 { settings, chatId? }，
   * 返回 { options: { value: string, label: string }[] }；失败返回错误 JSON。
   * settings 是当前未保存的表单草稿，可用 await parseSettingsDraft(c, ctx.settings) 和保存值合并。
   */
  routes?: (app: Hono, ctx: Omit<ExtensionContext, 'chatId'>) => void
}

export function defineExtension(extension: Extension): Extension {
  return extension
}

/** 缓存解析结果，草稿、会话和工作流检查共用同一次请求体读取。 */
const draftBodies = new WeakMap<Context, Promise<Record<string, unknown>>>()
export function draftBody(c: Context): Promise<Record<string, unknown>> {
  let body = draftBodies.get(c)
  if (!body) {
    body = c.req
      .json<unknown>()
      .then((value) =>
        value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {},
      )
      .catch(() => ({}))
    draftBodies.set(c, body)
  }
  return body
}
/** POST 草稿只接受 JSON 对象；缺失或格式错误时沿用已保存设置。 */
export async function parseSettingsDraft(c: Context, saved: Record<string, unknown>): Promise<Record<string, unknown>> {
  const draft = (await draftBody(c)).settings
  return draft && typeof draft === 'object' && !Array.isArray(draft) ? { ...saved, ...draft } : { ...saved }
}
export async function draftChatId(c: Context): Promise<string | undefined> {
  const chatId = (await draftBody(c)).chatId
  return typeof chatId === 'string' ? chatId : undefined
}
