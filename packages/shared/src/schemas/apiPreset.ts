import { z } from 'zod'

/**
 * 采样参数。键名直接用 OpenAI 的写法，发请求时原样展开进请求体。
 * extra 用来塞各家中转站的私有参数。
 */
export const apiParamsSchema = z.object({
  max_tokens: z.number().int().positive().default(1024),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  stop: z.array(z.string()).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
})
export type ApiParams = z.infer<typeof apiParamsSchema>

/** 新建 / 修改 API 预设的入参。apiKey 不传表示保持原值 */
export const apiPresetInput = z.object({
  name: z.string().trim().min(1),
  baseUrl: z.url(),
  apiKey: z.string().optional(),
  model: z.string().trim().min(1),
  contextSize: z.number().int().min(512).default(16384),
  params: apiParamsSchema.default({ max_tokens: 1024 }),
})
export type ApiPresetInput = z.input<typeof apiPresetInput>

/** 返回给前端的 API 预设，Key 已打码 */
export interface ApiPresetDTO {
  id: string
  name: string
  baseUrl: string
  model: string
  contextSize: number
  params: ApiParams
  apiKeyMasked: string
  isDefault: boolean
}

/** 测试连接的入参：可以测已保存的预设，也可以测表单里还没保存的值 */
export const testConnectionInput = z.object({
  presetId: z.string().optional(),
  baseUrl: z.url().optional(),
  apiKey: z.string().optional(),
})
export type TestConnectionInput = z.infer<typeof testConnectionInput>

export interface TestConnectionResult {
  ok: boolean
  models: string[]
  error?: string
}
