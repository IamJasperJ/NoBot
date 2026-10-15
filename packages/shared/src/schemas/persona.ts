import { z } from 'zod'

/** 用户人设，即 {{user}} */
export interface PersonaDTO {
  id: string
  name: string
  description: string
  isDefault: boolean
}

export const personaInput = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().optional(),
})
export type PersonaInput = z.infer<typeof personaInput>
