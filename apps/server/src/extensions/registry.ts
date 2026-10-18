import { readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { BuildInput } from '@ai-parter/core'
import type { ChatMessage, ExtensionDTO } from '@ai-parter/shared'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db, getSetting, setSetting } from '../db/client'
import { chats, messages, settings } from '../db/schema'
import { env } from '../env'
import { HttpError, notFound } from '../errors'
import { t } from '../i18n'
import { translateMetadata, translateSettingsSchema } from '../i18n/metadata'
import { profileChatScope, selectProfile } from '../services/profiles'
import { SETTING_KEYS } from '../services/settings'
import { setExtensionToolsProvider } from '../tools'
import caption, { generateCaption } from './builtin/caption'
import imageGen from './builtin/image-gen'
import regex from './builtin/regex'
import summary from './builtin/summary'
import { createExtensionHost } from './host'
import type { Extension, ExtensionContext, ExtensionManifest, ServerEvent } from './types'
import { restoreSecrets, SECRET_MASK } from './types'

/**
 * 扩展注册表：启动时加载内置扩展和 data/extensions/ 下的第三方扩展，
 * 生成流程通过这里的 run* 函数调用已启用扩展的钩子。
 * 任何一个扩展的钩子出错都只记日志、跳过它，不影响聊天本身。
 */

interface Loaded {
  extension: Extension
  source: 'builtin' | 'local'
  manifest?: ExtensionManifest
  directory?: string
  app?: Hono
  loadError?: string
}

const host = createExtensionHost(emitServerEvent)
const loaded: Loaded[] = []
const requestChat = profileChatScope

function createApp(extension: Extension): Hono | undefined {
  if (!extension.routes) return undefined
  const app = new Hono()
  app.use('*', async (c, next) => {
    let chatId = c.req.query('chatId') ?? ''
    if (c.req.method === 'POST') {
      const body: unknown = await c.req.raw
        .clone()
        .json()
        .catch(() => null)
      if (body && typeof body === 'object') {
        if ('chatId' in body && typeof body.chatId === 'string') chatId = body.chatId
        else if ('messageId' in body && typeof body.messageId === 'string') {
          const row = db.select().from(messages).where(eq(messages.id, body.messageId)).get()
          chatId = row?.chatId ?? ''
        }
      }
    }
    await requestChat.run(chatId, next)
  })
  app.onError((error, c) =>
    c.json(
      {
        error: {
          code: error instanceof HttpError ? error.code : 'INTERNAL',
          message:
            error instanceof HttpError
              ? error.message
              : t('服务器内部错误：{error}', { error: error.message || t('扩展接口执行失败') }),
        },
      },
      error instanceof HttpError ? error.status : 500,
    ),
  )
  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: t('扩展接口不存在') } }, 404))
  extension.routes(app, {
    get settings() {
      return contextOf(extension, requestChat.getStore() ?? '').settings
    },
    storage: storageOf(extension.id),
    host,
  })
  return app
}

/** 内置扩展与本地扩展共用路由和上下文，重复标识在注册时立即报错。 */
export function registerBuiltinExtension(extension: Extension) {
  if (loaded.some((entry) => entry.extension.id === extension.id))
    throw new Error(t('扩展 id「{id}」重复', { id: extension.id }))
  loaded.push({ extension, source: 'builtin', app: createApp(extension) })
}

registerBuiltinExtension(regex)
registerBuiltinExtension(imageGen)
registerBuiltinExtension(summary)
registerBuiltinExtension(caption)

const manifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string(),
  author: z.string().optional(),
  server: z.string().min(1).optional(),
  client: z.string().min(1).optional(),
  style: z.string().min(1).optional(),
})

/** 解析后的真实路径也必须在扩展目录内，避免软链接绕过目录检查。 */
async function localFile(directory: string, file: string) {
  if (isAbsolute(file) || file.includes('\\') || file.split('/').includes('..'))
    throw new Error(t('扩展文件路径不合法'))
  const root = await realpath(directory)
  const path = await realpath(resolve(root, file))
  const rel = relative(root, path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(t('扩展文件必须位于自己的目录内'))
  return path
}

/** 按目录名加载，manifest 存在时不回退到旧入口。 */
export async function loadLocalExtensions() {
  const dir = join(env.dataDir, 'extensions')
  let names: string[]
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return
  }
  for (let i = loaded.length - 1; i >= 0; i--) {
    if (loaded[i]?.source === 'local') loaded.splice(i, 1)
  }
  for (const name of names) {
    const directory = join(dir, name)
    try {
      let manifest: ExtensionManifest | undefined
      let extension: Extension
      const manifestFile = Bun.file(join(directory, 'manifest.json'))
      if (await manifestFile.exists()) {
        const raw: unknown = await manifestFile.json().catch(() => {
          throw new Error(t('manifest.json 不是合法的 JSON'))
        })
        const parsed = manifestSchema.safeParse(raw)
        if (!parsed.success) {
          const fields = parsed.error.issues.map((issue) => issue.path.join('.') || t('根对象')).join('、')
          throw new Error(t('manifest.json 不合法：{fields} 字段缺失或格式错误', { fields }))
        }
        manifest = parsed.data
        extension = manifest.server ? (await import(await localFile(directory, manifest.server))).default : manifest
        if (!extension || typeof extension !== 'object') throw new Error(t('后端入口必须默认导出扩展对象'))
        extension = { ...extension, ...manifest }
      } else {
        const file = (await Bun.file(join(directory, 'index.ts')).exists()) ? 'index.ts' : 'index.js'
        if (!(await Bun.file(join(directory, file)).exists())) continue
        extension = (await import(await localFile(directory, file))).default
        if (!extension?.id || !extension.name) throw new Error(t('默认导出必须是 defineExtension({ id, name, ... })'))
      }
      if (!/^[a-z0-9-]+$/.test(extension.id)) throw new Error(t('扩展 id 只能包含小写字母、数字和连字符'))
      if (loaded.some((l) => l.extension.id === extension.id))
        throw new Error(t('扩展 id「{id}」重复', { id: extension.id }))
      if (manifest?.client) await localFile(directory, manifest.client)
      if (manifest?.style) await localFile(directory, manifest.style)
      const entry: Loaded = { extension, source: 'local', manifest, directory }
      entry.app = createApp(extension)
      loaded.push(entry)
      console.log(`已加载扩展：${extension.name}（${extension.id}）`)
    } catch (e) {
      const loadError = e instanceof Error ? e.message : String(e)
      loaded.push({
        extension: { id: `broken:${name}`, name, description: '', version: '' },
        source: 'local',
        loadError,
      })
      console.error(`扩展「${name}」加载失败：`, loadError)
    }
  }
}

function storageOf(id: string): ExtensionContext['storage'] {
  const keyOf = (key: string) => `extdata:${id}:${key}`
  return {
    get: <T>(key: string) => getSetting<T>(keyOf(key)),
    set: (key, value) => setSetting(keyOf(key), value),
    delete: (key) => {
      db.delete(settings)
        .where(eq(settings.key, keyOf(key)))
        .run()
    },
  }
}

export async function extensionAsset(id: string, kind: 'client' | 'style') {
  const entry = loaded.find((l) => l.extension.id === id && isEnabled(l))
  const file = entry?.manifest?.[kind]
  if (!entry?.directory || !file) throw notFound(t('扩展资源'))
  try {
    return Bun.file(await localFile(entry.directory, file))
  } catch {
    throw notFound(t('扩展资源'))
  }
}

export function forwardExtension(id: string, request: Request) {
  const entry = loaded.find((l) => l.extension.id === id && isEnabled(l))
  if (!entry?.app) throw notFound(t('扩展接口'))
  const url = new URL(request.url)
  url.pathname = url.pathname.slice(`/api/ext/${id}`.length) || '/'
  return entry.app.fetch(new Request(url.toString(), request))
}

/** 异步隔离事件处理；同步异常和异步拒绝都不能影响主流程。 */
export function emitServerEvent(event: ServerEvent) {
  const chatId = 'chatId' in event ? event.chatId : event.message.chatId
  for (const { ext, ctx } of active(chatId)) {
    if (ext.hooks?.onEvent)
      void Promise.resolve()
        .then(() => profileChatScope.run(chatId, () => ext.hooks?.onEvent?.(event, ctx)))
        .catch((e) => {
          console.error(`扩展「${ext.name}」的 onEvent 出错：`, e)
        })
  }
}

function enabledMap(): Record<string, boolean> {
  return getSetting<Record<string, boolean>>(SETTING_KEYS.extensionsEnabled) ?? {}
}

function isEnabled(l: Loaded): boolean {
  if (l.loadError) return false
  return enabledMap()[l.extension.id] ?? l.extension.enabledByDefault ?? l.source === 'builtin'
}

function settingsOf(ext: Extension): Record<string, unknown> {
  return { ...ext.defaultSettings, ...getSetting<Record<string, unknown>>(SETTING_KEYS.extensionSettings(ext.id)) }
}

/** 设置里标了 secret 的字段名（API 密钥、Basic Auth 等） */
function secretKeys(ext: Extension): string[] {
  return (ext.settingsSchema ?? []).flatMap((field) =>
    field.type === 'string' && field.secret && 'key' in field ? [field.key] : [],
  )
}

/** 返回给前端的设置：有值的密钥换成占位串，不把明文发出去 */
function maskedSettingsOf(ext: Extension): Record<string, unknown> {
  const settings = settingsOf(ext)
  for (const key of secretKeys(ext)) if (settings[key]) settings[key] = SECRET_MASK
  return settings
}

function toDTO(l: Loaded): ExtensionDTO {
  const e = l.extension
  return {
    id: e.id,
    name: translateMetadata(e.name),
    description: translateMetadata(e.description),
    version: e.version,
    source: l.source,
    author: l.manifest?.author ?? '',
    client: { script: !!l.manifest?.client, style: !!l.manifest?.style },
    hasRoutes: !!e.routes,
    enabled: isEnabled(l),
    provides: {
      macros: Object.keys(e.macros ?? {}),
      tools: toolsOf(e, '').map((t) => t.name),
      hooks: Object.keys(e.hooks ?? {}),
    },
    settingsSchema: translateSettingsSchema(e.settingsSchema ?? []),
    settings: maskedSettingsOf(e),
    ...(l.loadError ? { loadError: l.loadError } : {}),
  }
}

/** 上传完成后按需说明；扩展关闭时不触发模型请求。 */
export async function captionUpload(id: string, chatId?: string) {
  const entry = loaded.find((entry) => entry.extension.id === 'caption')
  if (!entry || !isEnabled(entry)) return undefined
  return generateCaption(id, settingsOf(entry.extension), chatId)
}

export const listExtensions = () => loaded.map(toDTO)

export function updateExtension(id: string, patch: { enabled?: boolean; settings?: Record<string, unknown> }) {
  const l = loaded.find((x) => x.extension.id === id)
  if (!l) throw notFound(t('扩展'))
  if (patch.enabled !== undefined) setSetting(SETTING_KEYS.extensionsEnabled, { ...enabledMap(), [id]: patch.enabled })
  // 前端传回的密钥如果还是占位串，表示没改，保留原值
  if (patch.settings)
    setSetting(SETTING_KEYS.extensionSettings(id), restoreSecrets(patch.settings, settingsOf(l.extension)))
  return toDTO(l)
}

/** 已启用的扩展及其设置 */
function active(chatId: string): { ext: Extension; ctx: ExtensionContext }[] {
  return loaded.filter(isEnabled).map((l) => ({
    ext: l.extension,
    ctx: contextOf(l.extension, chatId),
  }))
}

function safely<T>(ext: Extension, hook: string, fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch (e) {
    console.error(`扩展「${ext.name}」的 ${hook} 出错：`, e)
    return fallback
  }
}

/** 所有已启用扩展提供的宏，供 buildPrompt 的 macros 参数使用 */
export function collectMacros(chatId: string): Record<string, (arg: string) => string> {
  const result: Record<string, (arg: string) => string> = {}
  for (const { ext, ctx } of active(chatId)) {
    for (const [name, fn] of Object.entries(ext.macros ?? {})) {
      result[name.toLowerCase()] = (arg) => safely(ext, `宏 ${name}`, () => fn(arg, ctx), '')
    }
  }
  return result
}

export function runBeforePrompt(input: BuildInput): BuildInput {
  return active(input.chat.id).reduce(
    (acc, { ext, ctx }) =>
      ext.hooks?.beforePrompt
        ? safely(ext, 'beforePrompt', () => ext.hooks?.beforePrompt?.(acc, ctx) ?? acc, acc)
        : acc,
    input,
  )
}

export function runAfterPrompt(messages: ChatMessage[], chatId: string): ChatMessage[] {
  return active(chatId).reduce(
    (acc, { ext, ctx }) =>
      ext.hooks?.afterPrompt ? safely(ext, 'afterPrompt', () => ext.hooks?.afterPrompt?.(acc, ctx) ?? acc, acc) : acc,
    messages,
  )
}

export function runTransform(kind: 'transformInput' | 'transformOutput', text: string, chatId: string): string {
  return active(chatId).reduce((acc, { ext, ctx }) => {
    const hook = ext.hooks?.[kind]
    return hook ? safely(ext, kind, () => hook(acc, ctx), acc) : acc
  }, text)
}

function contextOf(ext: Extension, chatId: string): ExtensionContext {
  const settings = settingsOf(ext)
  if (ext.id === 'image-gen') {
    const profile = selectProfile(
      chatId ? db.select().from(chats).where(eq(chats.id, chatId)).get() : undefined,
    ).profile
    // 配置组的图片连接只填给当前选中的后端（和 discovery.resolveImageConnection 一致）
    const source = settings.source ?? 'openai'
    if (source === 'openai') settings.openaiConnectionId ||= profile?.imageConnectionId ?? ''
    if (source === 'openrouter') settings.openrouterConnectionId ||= profile?.imageConnectionId ?? ''
    settings.promptConnectionId ||= profile?.promptConnectionId ?? ''
  }
  if (ext.id === 'regex' && chatId) {
    const scripts = selectProfile(db.select().from(chats).where(eq(chats.id, chatId)).get()).profile?.regexScripts
    if (scripts !== null && scripts !== undefined)
      // 配置组自己的一份规则，按它里面的开关启用
      settings.scripts = scripts
  }
  return { settings, chatId, storage: storageOf(ext.id), host }
}

function toolsOf(ext: Extension, chatId: string) {
  return safely(
    ext,
    'tools',
    () => (typeof ext.tools === 'function' ? ext.tools(contextOf(ext, chatId)) : (ext.tools ?? [])),
    [],
  )
}

// 执行时重新读取设置，并使用工具调用所属的会话上下文。
setExtensionToolsProvider((chatId = '') =>
  loaded.filter(isEnabled).flatMap(({ extension: ext }) =>
    toolsOf(ext, chatId).map((tool) => ({
      source: ext.name,
      tool: {
        ...tool,
        run: (args, ctx) =>
          profileChatScope.run(ctx.chatId, () => tool.run(args, { ...ctx, extension: contextOf(ext, ctx.chatId) })),
      },
    })),
  ),
)
