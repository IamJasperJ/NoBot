import type { PromptBlock } from '@ai-parter/shared'

/** 只接受 JSON 对象，避免数组或 null 被合并进请求体。 */
export function isExtraBodyValid(value: string): boolean {
  if (!value.trim()) return true
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
  } catch {
    return false
  }
}

/** 使用条目 id 排序，展开中的编辑器不会因移动而指向其他条目。 */
export function movePrompt(blocks: PromptBlock[], id: string, target: number): PromptBlock[] {
  const from = blocks.findIndex((block) => block.id === id)
  if (from < 0 || target < 0 || target >= blocks.length || from === target) return blocks
  const result = [...blocks]
  const [block] = result.splice(from, 1)
  if (block) result.splice(target, 0, block)
  return result
}
