import { AsyncLocalStorage } from 'node:async_hooks'
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BuildInput } from '@nobot/core'
import type { ChatMessage, ExtensionDTO, ExtensionGitInfo, ExtensionSettingField } from '@nobot/shared'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db, getSetting, setSetting } from '../db/client'
import { chats, messages, settings } from '../db/schema'
import { paths } from '../env'
import { HttpError, notFound } from '../errors'
import { t } from '../i18n'
import { translateMetadata, translateSettingsSchema } from '../i18n/metadata'
import { validate } from '../lib/validate'
import { cleanupExtensionStaging, readGitInfo } from '../services/extension-git'
import { profileChatScope, selectProfile } from '../services/profiles'
import { SETTING_KEYS } from '../services/settings'
import { setExtensionToolsProvider } from '../tools'
import { currentUser } from '../user-context'
import audio from './builtin/audio'
import { fishClient } from './builtin/audio/tts/fish'
import caption, { generateCaption } from './builtin/caption'
import imageGen from './builtin/image-gen'
import { applyProfileImage } from './builtin/image-gen/profile'
import { parseSettings as parseImageSettings } from './builtin/image-gen/settings'
import regex from './builtin/regex'
import summary from './builtin/summary'
import translate from './builtin/translate'
import { directoryRevision, localFile, readManifest } from './files'
import { createExtensionHost } from './host'
import { detectPermissions, isApproved, permissionFingerprint, permissionWarnings } from './permissions'
import type { Extension, ExtensionContext, ExtensionManifest, ServerEvent } from './types'
import { restoreSecrets, SECRET_MASK } from './types'

/**
 * 扩展注册表：启动时注册内置扩展，首次请求时加载当前用户目录下的第三方扩展，
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
  revision?: string
  git?: ExtensionGitInfo | null
  server?: boolean
  runtime?: string
  fileRevision?: string
}

const host = createExtensionHost(emitServerEvent)
const builtins: Loaded[] = []
const userExtensions = new Map<string, Loaded[]>()
const loading = new Map<string, Promise<unknown>>()
function localExtensions() {
  const handle = currentUser().handle
  let entries = userExtensions.get(handle)
  if (!entries) {
    entries = []
    userExtensions.set(handle, entries)
  }
  return entries
}
const visibleExtensions = () => [...builtins, ...localExtensions()]

/** 每用户只懒加载一次；保留 promise 合并并发的首次请求。 */
export async function ensureUserExtensions() {
  const handle = currentUser().handle
  let pending = loading.get(handle)
  if (!pending) {
    pending = loadLocalExtensions().catch((error) => {
      loading.delete(handle)
      throw error
    })
    loading.set(handle, pending)
  }
  await pending
}
export async function unloadUserExtensions() {
  const handle = currentUser().handle
  await loading.get(handle)
  for (const entry of [...localExtensions()]) await unloadExtension(entry.extension.id)
  userExtensions.delete(handle)
  loading.delete(handle)
}
const requestChat = profileChatScope
// 配置组编辑草稿必须从扩展原始设置起步，不能继承当前会话已经合并的配置组。
const imageProfileDraft = new AsyncLocalStorage<boolean>()

function createApp(extension: Extension): Hono | undefined {
  if (!extension.routes && !extension.commands?.length) return undefined
  const app = new Hono()
  app.use('*', async (c, next) => {
    const current = visibleExtensions().find((entry) => entry.extension === extension)
    if (!current || needsApproval(current)) throw notFound(t('扩展接口'))
    let chatId = c.req.query('chatId') ?? ''
    let hasImageDraft = false
    if (c.req.method === 'POST') {
      const body: unknown = await c.req.raw
        .clone()
        .json()
        .catch(() => null)
      if (body && typeof body === 'object') {
        hasImageDraft = Object.hasOwn(body, 'profileImage')
        if ('chatId' in body && typeof body.chatId === 'string') chatId = body.chatId
        else if ('messageId' in body && typeof body.messageId === 'string') {
          const row = db.select().from(messages).where(eq(messages.id, body.messageId)).get()
          chatId = row?.chatId ?? ''
        }
      }
    }
    await imageProfileDraft.run(hasImageDraft, () => requestChat.run(chatId, next))
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
  for (const command of extension.commands ?? []) {
    app.post(
      `/commands/${command.name}`,
      validate(
        'json',
        z.object({
          chatId: z.string().nullable().optional(),
          args: z.record(z.string(), z.string()),
          text: z.string(),
        }),
      ),
      async (c) => {
        const body = c.req.valid('json')
        const ctx = contextOf(extension, body.chatId ?? '')
        for (const arg of command.args) {
          const value = body.args[arg.name]
          if (
            (arg.required && value === undefined) ||
            (value !== undefined &&
              ((arg.type === 'number' && (!value.trim() || !Number.isFinite(Number(value)))) ||
                (arg.type === 'boolean' && !['true', 'false'].includes(value)) ||
                (arg.enum && !arg.enum.includes(value))))
          )
            throw new HttpError(400, 'INVALID_ARG', t('参数无效：{name}', { name: arg.name }))
        }
        return c.json({ result: (await command.run(ctx, body.args, body.text)) ?? '' })
      },
    )
  }
  extension.routes?.(app, {
    get settings() {
      if (extension.id === 'image-gen' && imageProfileDraft.getStore()) return settingsOf(extension)
      return contextOf(extension, requestChat.getStore() ?? '').settings
    },
    storage: storageOf(extension.id),
    host,
  })
  return app
}

/** 内置扩展与本地扩展共用路由和上下文，重复标识在注册时立即报错。 */
export function registerBuiltinExtension(extension: Extension) {
  if (builtins.some((entry) => entry.extension.id === extension.id))
    throw new Error(t('扩展 id「{id}」重复', { id: extension.id }))
  builtins.push({ extension, source: 'builtin', app: createApp(extension) })
}

registerBuiltinExtension(regex)
registerBuiltinExtension(imageGen)
registerBuiltinExtension(summary)
registerBuiltinExtension(caption)
registerBuiltinExtension(audio)
registerBuiltinExtension(translate)

/** 注销在注册表中的旧对象，之后的请求不能再找到旧路由、命令和钩子。 */
export async function unloadExtension(id: string) {
  const index = localExtensions().findIndex((entry) => entry.extension.id === id)
  if (index < 0) return
  const [entry] = localExtensions().splice(index, 1)
  try {
    await entry?.extension.dispose?.()
  } catch (error) {
    console.error(`扩展「${id}」清理失败：`, error)
  } finally {
    if (entry?.runtime) await rm(entry.runtime, { recursive: true, force: true })
  }
}

export function extensionLocation(id: string) {
  const entry = visibleExtensions().find((entry) => entry.extension.id === id)
  if (!entry) throw notFound(t('扩展'))
  return entry
}

/** 单扩展替换不触碰其他扩展；唯一运行目录同时刷新入口及其相对依赖。 */
export async function reloadExtension(id: string, directory: string) {
  const old = localExtensions().findIndex((entry) => entry.extension.id === id)
  if (builtins.some((entry) => entry.extension.id === id))
    throw new HttpError(400, 'BUILTIN_EXTENSION', t('不能替换或卸载内置扩展'))
  await unloadExtension(id)
  const entry = await loadDirectory(directory)
  if (id && entry.extension.id !== id) {
    if (!entry.loadError) {
      await entry.extension.dispose?.()
      if (entry.runtime) await rm(entry.runtime, { recursive: true, force: true })
      entry.loadError = t('重载时扩展 id 不能改变')
    }
    entry.extension = { id, name: id, description: '', version: '' }
    entry.app = undefined
  }
  if (old >= 0) localExtensions().splice(Math.min(old, localExtensions().length), 0, entry)
  else localExtensions().push(entry)
  return toDTO(entry)
}

async function loadDirectory(directory: string): Promise<Loaded> {
  const name = directory.split('/').at(-1) ?? directory
  let runtime: string | undefined
  try {
    const git = await readGitInfo(directory)
    const fileRevision = await directoryRevision(directory)
    const revision = git?.commit ?? fileRevision
    let manifest: ExtensionManifest | undefined
    let extension: Extension
    let server: string | undefined
    if (await Bun.file(join(directory, 'manifest.json')).exists()) {
      manifest = await readManifest(directory)
      server = manifest.server
      extension = manifest
    } else {
      server = (await Bun.file(join(directory, 'index.ts')).exists()) ? 'index.ts' : 'index.js'
      if (!(await Bun.file(join(directory, server)).exists())) throw new Error(t('扩展缺少 manifest.json'))
      extension = {} as Extension
    }
    if (server) {
      await localFile(directory, server)
      runtime = join(paths.extensions, `.runtime-${crypto.randomUUID()}`)
      await mkdir(runtime, { recursive: true })
      await cp(directory, runtime, { recursive: true, filter: (path) => path.split('/').at(-1) !== '.git' })
      const url = pathToFileURL(await localFile(runtime, server))
      url.searchParams.set('v', `${revision}-${crypto.randomUUID()}`)
      extension = (await import(url.href)).default
      if (!extension || typeof extension !== 'object') throw new Error(t('后端入口必须默认导出扩展对象'))
      // manifest 是权限与标识的唯一来源，后端导出不能覆盖声明。
      extension = { ...extension, ...manifest }
    }
    if (!extension.id || !extension.name) throw new Error(t('默认导出必须是 defineExtension({ id, name, ... })'))
    if (!/^[a-z0-9-]+$/.test(extension.id)) throw new Error(t('扩展 id 只能包含小写字母、数字和连字符'))
    if (visibleExtensions().some((entry) => entry.extension.id === extension.id))
      throw new Error(t('扩展 id「{id}」重复', { id: extension.id }))
    const entry: Loaded = {
      extension,
      source: 'local',
      manifest,
      directory,
      revision,
      git,
      server: !!server,
      runtime,
      fileRevision,
    }
    if (!needsApproval(entry)) entry.app = createApp(extension)
    return entry
  } catch (error) {
    if (runtime) await rm(runtime, { recursive: true, force: true })
    const loadError = error instanceof Error ? error.message : String(error)
    console.error(`扩展「${name}」加载失败：`, loadError)
    return {
      extension: { id: `broken:${name}`, name, description: '', version: '' },
      source: 'local',
      directory,
      loadError,
    }
  }
}

/** 扫描时跳过管理目录；未变化的扩展保留原对象及路由。 */
export async function loadLocalExtensions() {
  await cleanupExtensionStaging()
  const dir = paths.extensions
  // 运行副本和安装目录同级，扩展自身的相对依赖无需改写。
  for (const name of await readdir(dir)) {
    if (!/^\.runtime-[0-9a-f-]{36}$/.test(name)) continue
    const path = join(dir, name)
    if (!visibleExtensions().some((entry) => entry.runtime === path)) await rm(path, { recursive: true, force: true })
  }
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
  const directories = new Set(names.map((name) => join(dir, name)))
  for (const entry of visibleExtensions())
    if (entry.source === 'local' && entry.directory && !directories.has(entry.directory))
      await unloadExtension(entry.extension.id)
  for (const directory of directories) {
    const existing = visibleExtensions().find((entry) => entry.directory === directory)
    const git = await readGitInfo(directory).catch(() => null)
    const fileRevision = await directoryRevision(directory).catch(() => '')
    const revision = git?.commit ?? fileRevision
    if (existing && existing.revision === revision && existing.fileRevision === fileRevision && !existing.loadError) {
      existing.git = git
      continue
    }
    await reloadExtension(existing?.extension.id ?? '', directory)
  }
  return listExtensions()
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
  const entry = visibleExtensions().find((l) => l.extension.id === id && isEnabled(l))
  const file = entry?.manifest?.[kind]
  if (!entry?.directory || !file) throw notFound(t('扩展资源'))
  try {
    return Bun.file(await localFile(entry.directory, file))
  } catch {
    throw notFound(t('扩展资源'))
  }
}

function optionsSources(fields: ExtensionSettingField[]): string[] {
  return fields.flatMap((field) => {
    if (field.type === 'list') return optionsSources(field.itemFields)
    return 'optionsSource' in field && field.optionsSource ? [field.optionsSource.replace(/^\/+/, '')] : []
  })
}

export function forwardExtension(id: string, request: Request) {
  const entry = visibleExtensions().find((l) => l.extension.id === id && !l.loadError)
  if (!entry || needsApproval(entry)) throw notFound(t('扩展接口'))
  entry.app ??= createApp(entry.extension)
  if (!entry.app) throw notFound(t('扩展接口'))
  const url = new URL(request.url)
  url.pathname = url.pathname.slice(`/api/ext/${id}`.length) || '/'
  // 设置页允许在启用前编辑草稿，因此只放行声明过的候选 POST 接口，其他操作仍需启用扩展。
  const isOptionsRequest =
    request.method === 'POST' &&
    (optionsSources(entry.extension.settingsSchema ?? []).includes(url.pathname.replace(/^\/+/, '')) ||
      (entry.extension.id === 'image-gen' && ['/styles', '/comfy/workflows'].includes(url.pathname)))
  // 抠图组件全员共享，管理权限由具体路由校验，不依赖个人是否启用生图扩展。
  const isMattingRequest =
    entry.extension.id === 'image-gen' &&
    ((request.method === 'GET' && url.pathname === '/matting/status') ||
      (request.method === 'POST' && url.pathname === '/matting/install') ||
      (request.method === 'DELETE' && url.pathname === '/matting'))
  if (!isEnabled(entry) && !isOptionsRequest && !isMattingRequest) throw notFound(t('扩展接口'))
  return entry.app.fetch(new Request(url.toString(), request))
}

/** 异步隔离事件处理；同步异常和异步拒绝都不能影响主流程。 */
export function emitServerEvent(event: ServerEvent) {
  const chatId = 'chatId' in event ? event.chatId : event.message.chatId
  for (const { ext, ctx } of active(chatId)) {
    if (ext.hooks?.onEvent)
      void Promise.resolve()
        .then(() =>
          isCurrentActive(ext) ? profileChatScope.run(chatId, () => ext.hooks?.onEvent?.(event, ctx)) : undefined,
        )
        .catch((e) => {
          console.error(`扩展「${ext.name}」的 onEvent 出错：`, e)
        })
  }
}

function enabledMap(): Record<string, boolean> {
  return getSetting<Record<string, boolean>>(SETTING_KEYS.extensionsEnabled) ?? {}
}

function needsApproval(l: Loaded): boolean {
  if (l.source === 'builtin') return false
  const fingerprint = permissionFingerprint(
    l.manifest?.permissions ?? null,
    detectPermissions(l.extension, l.manifest, l.server),
  )
  return !isApproved(fingerprint, getSetting<Record<string, string>>('extensionsApproved')?.[l.extension.id])
}

function isEnabled(l: Loaded): boolean {
  if (l.loadError || needsApproval(l)) return false
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
    permissions:
      l.source === 'builtin'
        ? { ...detectPermissions(e, l.manifest, true), network: [] }
        : (l.manifest?.permissions ?? null),
    detected: detectPermissions(e, l.manifest, l.source === 'builtin' || l.server),
    permissionWarnings:
      l.source === 'builtin'
        ? []
        : permissionWarnings(l.manifest?.permissions ?? null, detectPermissions(e, l.manifest, l.server)),
    needsApproval: needsApproval(l),
    git: l.git ?? null,
    revision: l.source === 'builtin' ? 'builtin' : (l.revision ?? ''),
    commands: (e.commands ?? []).map(({ run: _run, ...description }) => description),
    name: translateMetadata(e.name),
    description: translateMetadata(e.description),
    version: e.version,
    source: l.source,
    author: l.manifest?.author ?? '',
    client: { script: !!l.manifest?.client, style: !!l.manifest?.style },
    hasRoutes: !!e.routes || !!e.commands?.length,
    enabled: isEnabled(l),
    provides: {
      macros: Object.keys(e.macros ?? {}),
      tools: (Array.isArray(e.tools) ? e.tools : needsApproval(l) ? [] : toolsOf(e, '')).map((t) => t.name),
      hooks: Object.keys(e.hooks ?? {}),
    },
    settingsSchema: translateSettingsSchema(e.settingsSchema ?? []),
    settings: maskedSettingsOf(e),
    ...(l.loadError ? { loadError: l.loadError } : {}),
  }
}

/** 上传完成后按需说明；扩展关闭时不触发模型请求。 */
export async function captionUpload(id: string, chatId?: string) {
  const entry = visibleExtensions().find((entry) => entry.extension.id === 'caption')
  if (!entry || !isEnabled(entry)) return undefined
  return generateCaption(id, settingsOf(entry.extension), chatId)
}

export const listExtensions = () => visibleExtensions().map(toDTO)

export function updateExtension(
  id: string,
  patch: { enabled?: boolean; settings?: Record<string, unknown>; approvePermissions?: boolean },
) {
  const l = visibleExtensions().find((x) => x.extension.id === id)
  if (!l) throw notFound(t('扩展'))
  if (patch.enabled && needsApproval(l) && !patch.approvePermissions)
    throw new HttpError(409, 'NEEDS_APPROVAL', t('启用扩展前需要确认权限'))
  if (patch.approvePermissions) {
    setSetting('extensionsApproved', {
      ...getSetting<Record<string, string>>('extensionsApproved'),
      [id]: permissionFingerprint(
        l.manifest?.permissions ?? null,
        detectPermissions(l.extension, l.manifest, l.server),
      ),
    })
    l.app ??= createApp(l.extension)
  }
  if (patch.enabled !== undefined) setSetting(SETTING_KEYS.extensionsEnabled, { ...enabledMap(), [id]: patch.enabled })
  // 前端传回的密钥如果还是占位串，表示没改，保留原值
  if (patch.settings) {
    setSetting(SETTING_KEYS.extensionSettings(id), restoreSecrets(patch.settings, settingsOf(l.extension)))
    if (id === 'audio') fishClient.clearCache()
  }
  return toDTO(l)
}

function isCurrentActive(extension: Extension) {
  return visibleExtensions().some((entry) => entry.extension === extension && isEnabled(entry))
}

/** 已启用的扩展及其设置 */
function active(chatId: string): { ext: Extension; ctx: ExtensionContext }[] {
  return visibleExtensions()
    .filter(isEnabled)
    .map((l) => ({
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
      result[name.toLowerCase()] = (arg) =>
        isCurrentActive(ext) ? safely(ext, `宏 ${name}`, () => fn(arg, ctx), '') : ''
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
  let settings = settingsOf(ext)
  if (ext.id === 'image-gen') {
    const profile = selectProfile(
      chatId ? db.select().from(chats).where(eq(chats.id, chatId)).get() : undefined,
    ).profile
    settings = applyProfileImage(parseImageSettings(settings), profile)
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
  visibleExtensions()
    .filter(isEnabled)
    .flatMap(({ extension: ext }) =>
      toolsOf(ext, chatId).map((tool) => ({
        source: ext.name,
        tool: {
          ...tool,
          run: (args, ctx) => {
            if (!isCurrentActive(ext)) throw new HttpError(400, 'EXTENSION_INACTIVE', t('扩展未启用或已重载'))
            return profileChatScope.run(ctx.chatId, () =>
              tool.run(args, { ...ctx, extension: contextOf(ext, ctx.chatId) }),
            )
          },
        },
      })),
    ),
)

/** 角色立绘生成与扩展共用真实设置和配置组连接，禁用扩展时拒绝启动。 */
export function imageGenerationContext(chatId = '', characterId?: string): ExtensionContext {
  const entry = visibleExtensions().find((entry) => entry.extension.id === 'image-gen' && isEnabled(entry))
  if (!entry) throw new HttpError(400, 'IMAGE_DISABLED', t('图片生成扩展未启用'))
  const context = contextOf(entry.extension, chatId)
  if (!chatId && characterId) {
    const profile = selectProfile({ characterId, groupId: null, profileId: null }).profile
    context.settings = applyProfileImage(parseImageSettings(settingsOf(entry.extension)), profile)
  }
  return context
}
