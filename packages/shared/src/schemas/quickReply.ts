import { z } from 'zod'

export const quickReplyEvents = [
  'onStartup',
  'onUser',
  'onAi',
  'onChatChange',
  'onGroupMemberDraft',
  'onNewChat',
] as const
export const quickReplySchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  title: z.string().default(''),
  message: z.string(),
  icon: z.string().optional(),
  isHidden: z.boolean().default(false),
  autoExecute: z
    .object({
      onStartup: z.boolean().default(false),
      onUser: z.boolean().default(false),
      onAi: z.boolean().default(false),
      onChatChange: z.boolean().default(false),
      onGroupMemberDraft: z.boolean().default(false),
      onNewChat: z.boolean().default(false),
    })
    .prefault({}),
  automationId: z.string().optional(),
})
export const quickReplySetInput = z.object({
  name: z.string().trim().min(1),
  buttons: z.array(quickReplySchema).refine((buttons) => new Set(buttons.map((b) => b.id)).size === buttons.length),
  disableSend: z.boolean().default(false),
  placeBeforeInput: z.boolean().default(false),
  injectInput: z.boolean().default(false),
})
export type QuickReply = z.output<typeof quickReplySchema>
export type QuickReplySetInput = z.input<typeof quickReplySetInput>
export interface QuickReplySet extends z.output<typeof quickReplySetInput> {
  id: string
}
export interface QuickReplyState {
  sets: QuickReplySet[]
  setIds: string[]
}

export interface CommandArg {
  name: string
  type: 'string' | 'number' | 'boolean' | 'enum'
  enum?: string[]
  required?: boolean
  description: string
}
export interface CommandDescription {
  name: string
  aliases?: string[]
  description: string
  args: CommandArg[]
  unnamed?: { description: string; enum?: string[] }
}
