import { z } from 'zod'

/**
 * 立绘（VN2）。设计见 docs/design/vn-mode.md 第 4 节。
 *
 * 每个角色可以有多套立绘（服装 outfit，空串是默认服装），每套里按表情（expression）存图，同一表情可以有多张。
 * 表情名沿用酒馆的 28 种英文名，也可以是自定义的英文名（小写）。
 * 文件存在 data/assets/sprites/<角色 id>/<立绘 id>.<扩展名>，保留原格式（PNG 透明背景最常见），另存一张缩略图。
 */

export interface SpriteDTO {
  id: string
  characterId: string
  /** 服装名，空串表示默认服装 */
  outfit: string
  /** 表情名（小写英文） */
  expression: string
  /** 原图地址 */
  url: string
  /** 缩略图地址（高 256 像素的 webp，保留透明） */
  thumbUrl: string
  width: number
  height: number
  createdAt: number
}

/** 修改一张立绘：改表情或挪到别的服装 */
export const updateSpriteInput = z.object({
  expression: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_-]+$/i, '表情名只能用英文字母、数字、_ 和 -')
    .transform((v) => v.toLowerCase())
    .optional(),
  outfit: z.string().trim().max(40).optional(),
})
export type UpdateSpriteInput = z.input<typeof updateSpriteInput>

/** 批量导入（上传多张或 zip）的结果 */
export interface SpriteImportResult {
  added: SpriteDTO[]
  /** 没导入的文件和原因，如「readme.txt：不是图片」 */
  skipped: string[]
}
