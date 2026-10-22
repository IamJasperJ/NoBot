import type { ExtensionContext } from '../../../types'
import type { Mode } from '../modes'

export type Context = Omit<ExtensionContext, 'chatId'>
export interface GenerateInput {
  chatId: string
  mode: Mode
  messageId?: string
  input?: string
  characterId?: string
  prompt?: string
  negative?: string
  snapshotId?: string
  origin?: 'button' | 'interactive'
  backgroundName?: string
}
