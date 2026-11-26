import type { MessageDTO, MessageMeta } from '@nobot/shared'
import { buildChildrenMap } from './tree'

interface ToolChainNode extends Pick<MessageDTO, 'id' | 'parentId' | 'role'> {
  meta: Pick<MessageMeta, 'toolCallId' | 'toolCalls'>
}

/** 从叶子向上记录当前分支的下一步，旧数据缺失父节点或出现环时停止。 */
function branchFrom(byId: ReadonlyMap<string, ToolChainNode>, leafId: string | null) {
  const branch = new Map<string, string>()
  let node = leafId === null ? undefined : byId.get(leafId)
  while (node && node.parentId !== null && !branch.has(node.parentId)) {
    branch.set(node.parentId, node.id)
    node = byId.get(node.parentId)
  }
  return branch
}

/** 排除或恢复消息时，工具调用与同一分支上配对的结果必须一起处理。 */
export function expandToolSelection(
  byId: ReadonlyMap<string, ToolChainNode>,
  selection: ToolChainNode[],
  activeLeafId: string | null,
): Set<string> {
  const selected = new Set(selection.map((node) => node.id))
  const children = buildChildrenMap(byId.values())
  const active = branchFrom(byId, activeLeafId)
  for (const message of selection) {
    let caller: ToolChainNode | undefined = message
    const explicit = new Map<string, string>()
    if (message.role === 'tool' && message.meta.toolCallId) {
      while (caller?.role === 'tool' && caller.parentId !== null && !explicit.has(caller.parentId)) {
        explicit.set(caller.parentId, caller.id)
        caller = byId.get(caller.parentId)
      }
      if (!caller?.meta.toolCalls?.some((call) => call.id === message.meta.toolCallId)) continue
    }
    if (caller?.role !== 'assistant' || !caller.meta.toolCalls) continue
    selected.add(caller.id)
    const calls = new Set(caller.meta.toolCalls.map((call) => call.id))
    const visited = new Set<string>()
    let current = caller
    while (!visited.has(current.id)) {
      visited.add(current.id)
      const kids = children.get(current.id)
      const nextId = explicit.get(current.id) ?? active.get(current.id)
      const next = kids?.find((node) => node.id === nextId) ?? kids?.at(-1)
      if (next?.role !== 'tool') break
      if (next.meta.toolCallId && calls.has(next.meta.toolCallId)) selected.add(next.id)
      current = next
    }
  }
  return selected
}
