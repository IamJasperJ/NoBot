import { expect, test } from 'bun:test'
import { expandToolSelection } from './tool-chain'

test('断链和循环的工具结果只处理显式选中的消息', () => {
  const result = (id: string, parentId: string) => ({
    id,
    parentId,
    role: 'tool' as const,
    meta: { toolCallId: 'call' },
  })
  const orphan = result('orphan', 'missing')
  const first = result('first', 'second')
  const second = result('second', 'first')
  const byId = new Map([orphan, first, second].map((node) => [node.id, node]))
  expect([...expandToolSelection(byId, [orphan, first], second.id)]).toEqual([orphan.id, first.id])
})
