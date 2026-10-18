import { z } from 'zod'

/**
 * 背景系统。
 * - 背景库：上传或生成的背景图片，文件在 data/assets/backgrounds/
 * - 全局背景：所有会话默认使用（存在 settings 表）
 * - 聊天背景：单个会话覆盖全局背景（chats.background_id）
 * - 舞台背景（VN 模式）：模型用 <scene bg> 指令切换的背景
 * 显示时：固定的聊天背景 > 舞台背景 > 聊天背景 > 角色或群组默认背景 > 全局背景 > 无背景（「固定」见 ChatDTO.backgroundPinned）。
 *
 * 范围：背景库是共用的，但图片生成扩展生成的背景属于生成它的会话（chatId）。
 * 舞台匹配、给模型的背景清单、自动选择都只看「公共背景 + 本会话生成的」，不会选到别的会话生成的背景。
 */
export interface BackgroundDTO {
  id: string
  folderIds: string[]
  name: string
  /** 一句话描述画面（地点、时间、氛围），和名字一起出现在给模型的背景清单里；可以为空 */
  description: string
  /** 生成它的会话；null 表示公共背景（用户上传、从网址导入，或手动设为公共） */
  chatId: string | null
  /** 原图地址（已转成 webp，最长边不超过 3840） */
  url: string
  /** 缩略图地址（最长边 320），背景库列表用 */
  thumbUrl: string
  width: number
  height: number
  /** upload：用户上传；generated：图片生成扩展生成 */
  source: 'upload' | 'generated'
  /**
   * 文件类型。静态图统一转成 image/webp；动态背景保留原格式：image/gif、video/mp4、video/webm
   * （和酒馆一样支持动态背景，视频用 <video autoplay loop muted> 显示）
   */
  mime: string
  /** 是否是动态背景（gif 或视频） */
  animated: boolean
  createdAt: number
}

/** 从网址导入背景（服务器下载） */
export const importBackgroundUrlInput = z.object({
  url: z.url(),
  name: z.string().trim().min(1).optional(),
})

/** 让模型从背景库里挑一张最适合当前场景的（对应酒馆的 /bg auto） */
export const autoBackgroundInput = z.object({
  chatId: z.string(),
})

export const updateBackgroundInput = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().max(200).optional(),
  /** 只能传 null：把会话生成的背景设为公共 */
  chatId: z.null().optional(),
})
export type UpdateBackgroundInput = z.infer<typeof updateBackgroundInput>

/** 全局背景设置 */
export interface BackgroundSettings {
  /** 全局背景的 id；null 表示不用背景 */
  globalId: string | null
}

export const backgroundSettingsInput = z.object({
  globalId: z.string().nullable(),
})

/** 自动换背景默认关闭；完整替换设置，避免局部更新含义不明确。 */
export const autoBackgroundSettingsSchema = z.object({
  lore: z.boolean().default(false),
  everyN: z.number().int().min(0).default(0),
})

export const backgroundFolderInput = z.object({
  name: z.string().trim().min(1),
  coverBackgroundId: z.string().nullable().default(null),
  sort: z.number().int().default(0),
})
export type BackgroundFolderInput = z.input<typeof backgroundFolderInput>
export interface BackgroundFolderDTO {
  id: string
  name: string
  coverBackgroundId: string | null
  sort: number
  createdAt: number
  updatedAt: number
}
export const backgroundFolderItemsInput = z.object({
  folderId: z.string(),
  backgroundIds: z.array(z.string()).min(1).max(2000),
})
export const batchDeleteBackgroundsInput = z.object({ ids: z.array(z.string()).min(1).max(2000) })
