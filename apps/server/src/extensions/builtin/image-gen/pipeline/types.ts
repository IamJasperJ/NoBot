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
  /** 自动生成的图片以来源回复为历史终点。 */
  historyLeafId?: string
  origin?: 'button' | 'interactive'
  /** 自动绘图使用的舞台场景名，重试时沿用。 */
  backgroundName?: string
}
