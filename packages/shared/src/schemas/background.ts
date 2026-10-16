import { z } from 'zod'

/**
 * 背景系统。
 * - 背景库：上传或生成的背景图片，文件在 data/assets/backgrounds/
 * - 全局背景：所有会话默认使用（存在 settings 表）
 * - 聊天背景：单个会话覆盖全局背景（chats.background_id）
 * 显示时：聊天背景 > 全局背景 > 无背景。
 */
export interface BackgroundDTO {
  id: string
  name: string
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
  name: z.string().trim().min(1),
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
