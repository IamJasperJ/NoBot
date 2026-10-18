import { z } from 'zod'
import { PROVIDER_IDS } from '../providers'

/**
 * 连接配置（对应酒馆的 Connection Profile）：只管「连到哪、用哪个模型」。
 * 采样参数、上下文长度等都在生成预设里。
 */
export const apiPresetInput = z.object({
  name: z.string().trim().min(1),
  /** 提供方（见 providers.ts），决定协议和默认地址；旧连接和手填的地址用 custom */
  provider: z.enum(PROVIDER_IDS).default('custom'),
  /** 提供方专用选项（Azure 部署名、Vertex 区域、Cloudflare 账户 ID 等），键见 ProviderInfo.options */
  options: z.record(z.string(), z.string()).default({}),
  baseUrl: z.url(),
  /** 不传表示保持原值 */
  apiKey: z.string().optional(),
  model: z.string().trim().min(1),
  vision: z.enum(['auto', 'yes', 'no']).default('auto'),
  /** 额外请求头：每个发往这个连接的请求（聊天、拉取模型、测试、图片生成复用连接时）都会带上，例如反向代理鉴权 */
  headers: z.record(z.string(), z.string()).default({}),
})
export type ApiPresetInput = z.input<typeof apiPresetInput>

/** 返回给前端的连接配置，Key 已打码 */
export interface ApiPresetDTO {
  id: string
  name: string
  provider: string
  options: Record<string, string>
  baseUrl: string
  model: string
  vision: 'auto' | 'yes' | 'no'
  apiKeyMasked: string
  /** 额外请求头（原样返回，编辑页需要显示和修改） */
  headers: Record<string, string>
  isDefault: boolean
}

/** 测试连接的入参：可以测已保存的配置，也可以测表单里还没保存的值 */
export const testConnectionInput = z.object({
  presetId: z.string().optional(),
  /** 表单里还没保存的提供方和选项；不传时用已保存配置的 */
  provider: z.enum(PROVIDER_IDS).optional(),
  options: z.record(z.string(), z.string()).optional(),
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
