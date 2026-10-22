import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ExtensionDTO,
  ExtensionGitInfo,
  ExtensionInstallPreview,
  ExtensionUpdateResult,
  GitStatusDTO,
} from '@nobot/shared'
import { eq } from 'drizzle-orm'
import { db, getSetting, setSetting } from '../../db/client'
import { settings } from '../../db/schema'
import { paths } from '../../env'
import { HttpError, notFound } from '../../errors'
import { readManifest } from '../../extensions/files'
import { isApproved, permissionFingerprint, permissionWarnings } from '../../extensions/permissions'
import {
  extensionLocation,
  listExtensions,
  reloadExtension,
  unloadExtension,
  updateExtension,
} from '../../extensions/registry'
import { t } from '../../i18n'
import { currentUser } from '../../user-context'

const root = () => paths.extensions
const staging = () => join(root(), '.staging')
const lifetime = 30 * 60 * 1000
const pending = new Map<string, { directory: string; expires: number; timer: ReturnType<typeof setTimeout> }>()

/** 所有管理写入串行执行，避免确认、切换与删除互相覆盖。 */
const queues = new Map<string, Promise<unknown>>()
export function extensionOperation<T>(operation: () => Promise<T>): Promise<T> {
  const handle = currentUser().handle
  const queue = queues.get(handle) ?? Promise.resolve()
  const next = queue.then(operation)
  const settled = next.catch(() => undefined)
  queues.set(handle, settled)
  void settled.finally(() => {
    if (queues.get(handle) === settled) queues.delete(handle)
  })
  return next
}

function hasUnsafeCharacters(value: string) {
  return [...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
}

export function validateGitUrl(url: string) {
  let valid = /^git@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?:[^\s]+$/.test(url)
  try {
    const parsed = new URL(url)
    valid ||=
      /^https:\/\//i.test(url) &&
      parsed.protocol === 'https:' &&
      !!parsed.hostname &&
      !parsed.username &&
      !parsed.password
  } catch {}
  if (!valid || hasUnsafeCharacters(url) || url.startsWith('-'))
    throw new HttpError(400, 'INVALID_GIT_URL', t('Git 地址只允许 HTTPS 或 git@host:path'))
  return url
}

export function validateGitRef(ref: string) {
  if (
    ref.startsWith('-') ||
    hasUnsafeCharacters(ref) ||
    /[~^:?*[\\]/.test(ref) ||
    ref.includes('..') ||
    ref.includes('@{')
  )
    throw new HttpError(400, 'INVALID_GIT_REF', t('Git 分支或标签不合法'))
  return ref
}

/** 参数数组不经过 shell；禁用交互、仓库钩子与外部协议，超时杀死子进程。 */
export async function runGit(args: string[], cwd?: string): Promise<string> {
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    child = Bun.spawn(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oConnectTimeout=15' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    throw new HttpError(400, 'GIT_UNAVAILABLE', t('服务器未安装 Git 或 Git 无法运行'))
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, 120000)
  try {
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (timedOut) throw new HttpError(400, 'GIT_TIMEOUT', t('Git 操作超时'))
    if (code !== 0) throw new HttpError(400, 'GIT_FAILED', t('Git 操作失败：{error}', { error: error.trim() }))
    return output.trim()
  } finally {
    clearTimeout(timer)
  }
}

export async function gitStatus(): Promise<GitStatusDTO> {
  try {
    return { available: true, version: await runGit(['--version']) }
  } catch {
    return { available: false }
  }
}

export async function readGitInfo(directory: string): Promise<ExtensionGitInfo | null> {
  if (!(await Bun.file(join(directory, '.git', 'HEAD')).exists())) return null
  const commit = await runGit(['rev-parse', 'HEAD'], directory)
  const ref = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], directory).catch(() => commit)
  const url = await runGit(['remote', 'get-url', 'origin'], directory).catch(() => '')
  const metadata = getSetting<Record<string, Partial<ExtensionGitInfo>>>('extensionGitChecks')?.[directory]
  return {
    url,
    ref,
    commit,
    remoteCommit: metadata?.remoteCommit ?? null,
    hasUpdate: metadata?.remoteCommit ? metadata.remoteCommit !== commit : null,
    checkedAt: metadata?.checkedAt ?? null,
  }
}

/** 启动时移除上次进程遗留的暂存；本次进程的暂存由定时器到期删除。 */
export async function cleanupExtensionStaging() {
  await mkdir(staging(), { recursive: true })
  for (const entry of await readdir(staging())) {
    if (!pending.has(`${currentUser().handle}:${entry}`))
      await rm(join(staging(), entry), { recursive: true, force: true })
  }
}

export async function previewExtension(input: { url: string; ref?: string }) {
  return previewRepository(validateGitUrl(input.url), input.ref ?? '')
}

/** 内部入口允许测试使用临时 bare 仓库；HTTP 路由只能调用上面的 URL 校验入口。 */
export async function previewRepository(url: string, ref = ''): Promise<ExtensionInstallPreview> {
  validateGitRef(ref)
  const token = crypto.randomUUID()
  const directory = join(staging(), token)
  await mkdir(staging(), { recursive: true })
  try {
    await runGit(['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), '--', url, directory])
    const manifest = await readManifest(directory)
    if (listExtensions().some((entry) => entry.id === manifest.id && entry.source === 'builtin'))
      throw new HttpError(400, 'BUILTIN_EXTENSION', t('不能替换或卸载内置扩展'))
    const detected = { server: !!manifest.server, client: !!(manifest.client || manifest.style) }
    const timer = setTimeout(() => void cancelInstall(token).catch(console.error), lifetime)
    timer.unref()
    pending.set(`${currentUser().handle}:${token}`, { directory, expires: Date.now() + lifetime, timer })
    return {
      token,
      manifest: { ...manifest, author: manifest.author ?? '' },
      permissions: manifest.permissions ?? null,
      detected,
      warnings: permissionWarnings(manifest.permissions ?? null, detected),
      ref: await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], directory).catch(() => ref),
      commit: await runGit(['rev-parse', 'HEAD'], directory),
      exists:
        listExtensions().some((entry) => entry.id === manifest.id) ||
        (await stat(join(root(), manifest.id)).then(
          () => true,
          () => false,
        )),
    }
  } catch (error) {
    await cancelInstall(token)
    await rm(directory, { recursive: true, force: true })
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'INVALID_EXTENSION', t('扩展安装失败：{error}', { error: String(error) }))
  }
}

export async function cancelInstall(token: string) {
  const item = pending.get(`${currentUser().handle}:${token}`)
  if (!item) return
  pending.delete(`${currentUser().handle}:${token}`)
  clearTimeout(item.timer)
  await rm(item.directory, { recursive: true, force: true })
}

/** 删除账号前清理预览定时器，避免归档后旧定时器再次访问用户目录。 */
export async function cancelUserInstallPreviews() {
  const prefix = `${currentUser().handle}:`
  for (const key of [...pending.keys()]) {
    if (key.startsWith(prefix)) await cancelInstall(key.slice(prefix.length))
  }
}

export async function confirmInstall(token: string, enable: boolean): Promise<ExtensionDTO> {
  const item = pending.get(`${currentUser().handle}:${token}`)
  if (!item || item.expires <= Date.now()) {
    await cancelInstall(token)
    throw new HttpError(400, 'INSTALL_EXPIRED', t('安装预览已过期，请重新预览'))
  }
  const manifest = await readManifest(item.directory)
  const existing = listExtensions().find((entry) => entry.id === manifest.id)
  if (existing?.source === 'builtin') throw new HttpError(400, 'BUILTIN_EXTENSION', t('不能替换或卸载内置扩展'))
  const previous = existing ? extensionLocation(manifest.id).directory : undefined
  await unloadExtension(manifest.id)
  if (previous) await rm(previous, { recursive: true, force: true })
  const destination = join(root(), manifest.id)
  await rm(destination, { recursive: true, force: true })
  await rename(item.directory, destination)
  clearTimeout(item.timer)
  pending.delete(`${currentUser().handle}:${token}`)
  const extension = await reloadExtension(manifest.id, destination)
  if (extension.loadError) return extension
  return updateExtension(manifest.id, { enabled: enable, approvePermissions: enable })
}

function gitLocation(id: string) {
  const entry = extensionLocation(id)
  if (entry.source === 'builtin' || !entry.directory || !entry.git)
    throw new HttpError(400, 'NOT_GIT_EXTENSION', t('此扩展不是通过 Git 安装的本地扩展'))
  return entry.directory
}

async function fetchRepository(directory: string) {
  await runGit(['remote', 'set-branches', 'origin', '*'], directory)
  await runGit(['fetch', '--prune', '--tags', 'origin', '+refs/heads/*:refs/remotes/origin/*'], directory)
}

export async function checkExtensionUpdate(id: string): Promise<ExtensionDTO> {
  const directory = gitLocation(id)
  await fetchRepository(directory)
  const remoteCommit = await runGit(['rev-parse', '--verify', '@{upstream}'], directory).catch(() => null)
  setSetting('extensionGitChecks', {
    ...getSetting<Record<string, Partial<ExtensionGitInfo>>>('extensionGitChecks'),
    [directory]: { remoteCommit, checkedAt: Date.now() },
  })
  return refreshGitDTO(id, directory)
}

async function refreshGitDTO(id: string, directory: string) {
  const git = await readGitInfo(directory)
  const entry = extensionLocation(id)
  entry.git = git
  return listExtensions().find((entry) => entry.id === id)!
}

async function ensureClean(directory: string) {
  if (await runGit(['status', '--porcelain'], directory))
    throw new HttpError(400, 'GIT_DIRTY', t('扩展有本地修改，请先提交或移除修改再更新或切换'))
}

export async function updateGitExtension(id: string): Promise<ExtensionUpdateResult> {
  const directory = gitLocation(id)
  await ensureClean(directory)
  const before = listExtensions().find((entry) => entry.id === id)!
  await runGit(['pull', '--ff-only'], directory)
  const remoteCommit = await runGit(['rev-parse', '--verify', '@{upstream}'], directory)
  setSetting('extensionGitChecks', {
    ...getSetting<Record<string, Partial<ExtensionGitInfo>>>('extensionGitChecks'),
    [directory]: { remoteCommit, checkedAt: Date.now() },
  })
  await reloadExtension(id, directory)
  const extension = await refreshGitDTO(id, directory)
  return {
    extension,
    permissionsChanged: !isApproved(
      permissionFingerprint(extension.permissions, extension.detected),
      permissionFingerprint(before.permissions, before.detected),
    ),
  }
}

export async function extensionBranches(id: string) {
  const directory = gitLocation(id)
  await fetchRepository(directory)
  const refs = await runGit(
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin', 'refs/tags'],
    directory,
  )
  return {
    current: (await readGitInfo(directory))!.ref,
    branches: [...new Set(refs.split('\n').filter((ref) => ref && ref !== 'origin/HEAD'))],
  }
}

export async function switchExtension(id: string, ref: string) {
  validateGitRef(ref)
  if (!ref) throw new HttpError(400, 'INVALID_GIT_REF', t('Git 分支或标签不合法'))
  const directory = gitLocation(id)
  await ensureClean(directory)
  await fetchRepository(directory)
  // checkout 的结束选项符放在 ref 后，明确把 ref 当作版本而不是路径。
  const remoteRef = ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref
  const local = await runGit(['show-ref', '--verify', `refs/heads/${remoteRef}`], directory).then(
    () => true,
    () => false,
  )
  const remote = await runGit(['show-ref', '--verify', `refs/remotes/origin/${remoteRef}`], directory).then(
    () => true,
    () => false,
  )
  const tag = await runGit(['show-ref', '--verify', `refs/tags/${ref}`], directory).then(
    () => true,
    () => false,
  )
  if (remote && !tag) {
    if (local) await runGit(['checkout', remoteRef, '--'], directory)
    else await runGit(['checkout', '-b', remoteRef, '--track', `origin/${remoteRef}`, '--'], directory)
  } else await runGit(['checkout', ref, '--'], directory)
  await reloadExtension(id, directory)
  return refreshGitDTO(id, directory)
}

export async function uninstallExtension(id: string) {
  const entry = extensionLocation(id)
  if (entry.source === 'builtin') throw new HttpError(400, 'BUILTIN_EXTENSION', t('不能替换或卸载内置扩展'))
  if (!entry.directory) throw notFound(t('扩展目录'))
  await unloadExtension(id)
  await rm(entry.directory, { recursive: true, force: true })
  for (const key of ['extensionsEnabled', 'extensionsApproved']) {
    const values = { ...getSetting<Record<string, unknown>>(key) }
    delete values[id]
    setSetting(key, values)
  }
  const checks = { ...getSetting<Record<string, unknown>>('extensionGitChecks') }
  delete checks[entry.directory]
  setSetting('extensionGitChecks', checks)
  for (const row of db.select().from(settings).all()) {
    if (row.key === `ext:${id}` || row.key.startsWith(`extdata:${id}:`))
      db.delete(settings).where(eq(settings.key, row.key)).run()
  }
}
