import { z } from 'zod'

/** 用户人设，即 {{user}}。可以有多个，在会话里切换 */
export interface PersonaDTO {
  id: string
  name: string
  description: string
  avatarUrl: string | null
  /** 人设绑定的世界书：用这个人设时自动生效 */
  lorebookId: string | null
  isDefault: boolean
}

export const personaInput = z.object({
  name: z.string().trim().min(1),
  description: z.string().default(''),
  lorebookId: z.string().nullable().default(null),
})
export type PersonaInput = z.input<typeof personaInput>

export const personaUpdateInput = personaInput.partial()
export type PersonaUpdateInput = z.infer<typeof personaUpdateInput>
