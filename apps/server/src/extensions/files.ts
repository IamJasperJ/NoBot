import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { extensionPermissionsSchema } from '@nobot/shared'
import { z } from 'zod'
import { t } from '../i18n'

export const manifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string(),
  author: z.string().optional(),
  server: z.string().min(1).optional(),
  client: z.string().min(1).optional(),
  style: z.string().min(1).optional(),
  permissions: extensionPermissionsSchema.optional(),
})

/** 解析后的真实路径也必须在扩展目录内，避免软链接绕过目录检查。 */
export async function localFile(directory: string, file: string) {
  if (isAbsolute(file) || file.includes('\\') || file.split('/').includes('..'))
    throw new Error(t('扩展文件路径不合法'))
  const root = await realpath(directory)
  const path = await realpath(resolve(root, file))
  const rel = relative(root, path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(t('扩展文件必须位于自己的目录内'))
  return path
}

export async function readManifest(directory: string) {
  const path = await localFile(directory, 'manifest.json').catch(() => {
    throw new Error(t('扩展缺少 manifest.json'))
  })
  const raw: unknown = await Bun.file(path)
    .json()
    .catch(() => {
      throw new Error(t('manifest.json 不是合法的 JSON'))
    })
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || t('根对象')).join('、')
    throw new Error(t('manifest.json 不合法：{fields} 字段缺失或格式错误', { fields }))
  }
  for (const file of [parsed.data.server, parsed.data.client, parsed.data.style])
    if (file) await localFile(directory, file)
  return parsed.data
}

/** 不跟随软链接，避免扫描仓库外文件或产生目录循环。 */
export async function directoryRevision(directory: string): Promise<string> {
  let maximum = (await stat(directory)).mtimeMs
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.isSymbolicLink()) continue
    const path = join(directory, entry.name)
    maximum = Math.max(
      maximum,
      entry.isDirectory() ? Number(await directoryRevision(path)) : (await stat(path)).mtimeMs,
    )
  }
  return String(maximum)
}
