import { z } from 'zod'

/**
 * 连接配置（对应酒馆的 Connection Profile）：只管「连到哪、用哪个模型」。
 * 采样参数、上下文长度等都在生成预设里。
 */
export const apiPresetInput = z.object({
  name: z.string().trim().min(1),
  baseUrl: z.url(),
  /** 不传表示保持原值 */
  apiKey: z.string().optional(),
  model: z.string().trim().min(1),
  /** 额外请求头：每个发往这个连接的请求（聊天、拉取模型、测试、图片生成复用连接时）都会带上，例如反向代理鉴权 */
  headers: z.record(z.string(), z.string()).default({}),
})
export type ApiPresetInput = z.input<typeof apiPresetInput>

/** 返回给前端的连接配置，Key 已打码 */
export interface ApiPresetDTO {
  id: string
  name: string
  baseUrl: string
  model: string
  apiKeyMasked: string
  /** 额外请求头（原样返回，编辑页需要显示和修改） */
  headers: Record<string, string>
  isDefault: boolean
}

/** 测试连接的入参：可以测已保存的配置，也可以测表单里还没保存的值 */
export const testConnectionInput = z.object({
  presetId: z.string().optional(),
  baseUrl: z.url().optional(),
  apiKey: z.string().optional(),
  /** 表单里还没保存的额外请求头；不传时用已保存配置的 */
  headers: z.record(z.string(), z.string()).optional(),
})
export type TestConnectionInput = z.infer<typeof testConnectionInput>

export interface TestConnectionResult {
  ok: boolean
  models: string[]
  error?: string
}
