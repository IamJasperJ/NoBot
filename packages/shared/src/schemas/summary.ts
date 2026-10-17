import { z } from 'zod'

/**
 * 总结扩展（内置扩展 id 'summary'，默认关闭）的接口契约，接口都在 /api/ext/summary/ 下：
 * - GET    /state?chatId=      → SummaryStateDTO
 * - POST   /run     { chatId } → SummaryStateDTO（手动立即总结，等总结完成再返回；正在总结时 409）
 * - PATCH  /entry   editSummaryInput   → SummaryStateDTO（改某条消息上的总结，改完 auto 变 false）
 * - DELETE /entry   deleteSummaryInput → SummaryStateDTO（删掉某条消息上的总结）
 * - POST   /freeze  freezeSummaryInput → SummaryStateDTO（暂停 / 恢复这个会话的自动总结）
 * 扩展关闭时这些接口 404。
 */

export interface SummaryEntryDTO {
  /** 总结挂在哪条消息上（总结到这条为止） */
  messageId: string
  text: string
  createdAt: number
  auto: boolean
  coveredCount: number
  /** 那条消息的摘要：发言人名 + 去掉舞台指令后的前 40 个字（Array.from 计数，超出加「…」） */
  preview: string
}

export interface SummaryStateDTO {
  /** 激活路径上最近的一份总结 */
  current: SummaryEntryDTO | null
  /** 激活路径上更早的总结，新的在前 */
  history: SummaryEntryDTO[]
  /**
   * 上一份总结之后、还没总结的素材（不含激活路径的最后一条，和总结时的规则一致）：
   * 条数，以及按 core 的 countTokens 估算的 token 数
   */
  pending: { messages: number; tokens: number }
  /** 这个会话暂停了自动总结 */
  frozen: boolean
  /** 这个会话正在总结 */
  running: boolean
  /** 这个会话上一次总结失败的原因；成功后清空 */
  lastError: string | null
}

export const summaryChatInput = z.object({ chatId: z.string() })
export type SummaryChatInput = z.infer<typeof summaryChatInput>

export const editSummaryInput = z.object({
  chatId: z.string(),
  messageId: z.string(),
  text: z.string().trim().min(1).max(20000),
})
export type EditSummaryInput = z.infer<typeof editSummaryInput>

export const deleteSummaryInput = z.object({ chatId: z.string(), messageId: z.string() })
export type DeleteSummaryInput = z.infer<typeof deleteSummaryInput>

export const freezeSummaryInput = z.object({ chatId: z.string(), frozen: z.boolean() })
export type FreezeSummaryInput = z.infer<typeof freezeSummaryInput>
