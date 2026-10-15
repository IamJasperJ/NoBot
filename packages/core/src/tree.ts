/**
 * 消息树的纯计算。
 * 每条消息只记 parentId；同一个父节点下的兄弟节点就是 swipe。
 * 兄弟节点按 id 升序排列，id 是 ULID，所以也就是创建顺序。
 */

export interface TreeNode {
  id: string
  parentId: string | null
}

/** 构建 父节点 id → 子节点列表 的映射。根节点的父 id 记作 null */
export function buildChildrenMap<T extends TreeNode>(nodes: T[]): Map<string | null, T[]> {
  const map = new Map<string | null, T[]>()
  for (const node of nodes) {
    const list = map.get(node.parentId)
    if (list) list.push(node)
    else map.set(node.parentId, [node])
  }
  for (const list of map.values()) list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return map
}

/**
 * 从 startId 出发，每层都走「最新的子节点」，返回最终到达的叶子。
 * 切换 swipe 时用它：切到某个兄弟节点后，继续显示它下面最近一次聊到的位置。
 */
export function findLatestLeaf(children: Map<string | null, TreeNode[]>, startId: string): string {
  let current = startId
  while (true) {
    const kids = children.get(current)
    const last = kids?.at(-1)
    if (!last) return current
    current = last.id
  }
}

/** 计算某个节点在兄弟中的位置（从 1 开始）和兄弟总数 */
export function swipeInfo(
  children: Map<string | null, TreeNode[]>,
  node: TreeNode,
): { swipeIndex: number; swipeCount: number } {
  const siblings = children.get(node.parentId) ?? [node]
  const index = siblings.findIndex((s) => s.id === node.id)
  return { swipeIndex: index + 1, swipeCount: siblings.length }
}

/** 找到 node 往左（-1）或往右（+1）的兄弟节点，没有则返回 null */
export function siblingOf(
  children: Map<string | null, TreeNode[]>,
  node: TreeNode,
  direction: -1 | 1,
): TreeNode | null {
  const siblings = children.get(node.parentId) ?? []
  const index = siblings.findIndex((s) => s.id === node.id)
  return siblings[index + direction] ?? null
}

/** 收集某个节点及其整棵子树的 id（删除消息时用） */
export function collectSubtree(children: Map<string | null, TreeNode[]>, rootId: string): string[] {
  const result: string[] = []
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop() as string
    result.push(id)
    for (const kid of children.get(id) ?? []) stack.push(kid.id)
  }
  return result
}
