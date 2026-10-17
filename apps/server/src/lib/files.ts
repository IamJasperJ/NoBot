import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { paths } from '../env'
import { HttpError } from '../errors'
import { t } from '../i18n'

/**
 * 头像文件的保存与读取。角色和人设共用：
 * 原图存 {id}.png（导出角色卡要用），缩略图存 {id}.webp（256px，界面上用，体积小）。
 */

export const thumbFile = (avatarFile: string) => avatarFile.replace(/\.png$/, '.webp')

/** 头像地址，带上更新时间作为版本号，内容变了地址就变，可以放心长期缓存 */
export const avatarUrl = (avatarFile: string | null, version: number) =>
  avatarFile ? `/api/assets/avatars/${thumbFile(avatarFile)}?v=${version}` : null

/** 保存头像：任何格式的图片都转成 PNG 原图 + WebP 缩略图，返回原图文件名 */
export async function saveAvatar(id: string, bytes: Uint8Array): Promise<string> {
  const file = `${id}.png`
  try {
    const image = sharp(bytes)
    // PNG 原样保存（角色卡的数据就在 PNG 的文本块里，不能重新编码）；其他格式转成 PNG
    const meta = await image.metadata()
    const png = meta.format === 'png' ? bytes : await image.png().toBuffer()
    await Bun.write(join(paths.avatars, file), png)
    await sharp(bytes)
      .resize(256, 256, { fit: 'cover', position: 'top' })
      .webp({ quality: 82 })
      .toFile(join(paths.avatars, thumbFile(file)))
  } catch {
    throw new HttpError(400, 'BAD_IMAGE', t('无法识别的图片文件'))
  }
  return file
}

export async function deleteAvatar(avatarFile: string | null) {
  if (!avatarFile) return
  await rm(join(paths.avatars, avatarFile), { force: true })
  await rm(join(paths.avatars, thumbFile(avatarFile)), { force: true })
}

export const readAvatar = (avatarFile: string) => Bun.file(join(paths.avatars, avatarFile))

/** 从 multipart 表单里取出上传的文件，限制大小 */
export async function readUpload(body: Record<string, unknown>, field = 'file', maxMB = 20): Promise<Uint8Array> {
  const file = body[field]
  if (!(file instanceof File)) throw new HttpError(400, 'BAD_REQUEST', t('请上传文件'))
  if (file.size > maxMB * 1024 * 1024)
    throw new HttpError(400, 'TOO_LARGE', t('文件太大（上限 {limit}MB）', { limit: maxMB }))
  return new Uint8Array(await file.arrayBuffer())
}
