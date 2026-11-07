import { describe, expect, test } from 'bun:test'
import {
  parseInboundId,
  primaryBinding,
  promptHintFor,
  type RouteMessage,
  routeTarget,
  sameLocation,
} from './cross-platform'

const bindings = [
  { id: 'a', provider: 'telegram', chat: '42', thread: '', state: 'active' },
  { id: 'b', provider: 'other.dm', chat: 'u1', thread: '', state: 'active' },
  { id: 'c', provider: 'telegram', chat: '42', thread: 'topic', state: 'active' },
  { id: 'd', provider: 'telegram', chat: '42', thread: '', state: 'active' },
]
const user: RouteMessage = {
  id: 'u',
  parentId: null,
  role: 'user',
  createdAt: 100,
  meta: { clientMessageId: 'other.dm:u1:1' },
}
const reply: RouteMessage = { id: 'm', parentId: 'u', role: 'assistant', createdAt: 200, meta: {} }
const route = (message = reply, parents = [user], primary = 'a') =>
  routeTarget(message, parents, bindings, primary, 200)

describe('主渠道与来源位置路由', () => {
  test('主绑定缺失、删除或停用时按创建顺序回退，全部停用则无目标', () => {
    expect(primaryBinding(bindings, 'b')?.id).toBe('b')
    expect(primaryBinding(bindings, 'deleted')?.id).toBe('a')
    expect(primaryBinding([{ ...bindings[1]!, state: 'disabled' }, bindings[0]!], 'b')?.id).toBe('a')
    expect(primaryBinding([])).toBeUndefined()
  })
  test('平台用户消息一律不转发，网页用户消息只选择主位置', () => {
    for (const id of ['telegram:42:1', 'other.dm:u1:2', 'unknown:place:3']) {
      expect(route({ ...user, meta: { clientMessageId: id } })).toBeNull()
    }
    expect(route({ ...user, meta: {} })?.id).toBe('a')
    expect(route({ ...user, meta: { clientMessageId: 'web-uuid' } }, [], 'b')?.id).toBe('b')
  })
  test('最近 user 决定来源，工具和多层连发沿实际父链查找', () => {
    expect(route()?.id).toBe('b')
    const tool = { ...reply, id: 'tool', parentId: 'm', role: 'tool' }
    expect(route(tool, [user, reply])?.id).toBe('b')
    const web = { ...user, id: 'web', parentId: 'u', meta: {} }
    expect(route({ ...reply, parentId: 'web' }, [user, web])?.id).toBe('a')
    expect(route(reply, [{ ...user, meta: { clientMessageId: 'unknown:place:1' } }])?.id).toBe('a')
  })
  test('30 分钟含边界；超时、无 user、网页、开场白均走主渠道', () => {
    expect(route({ ...reply, createdAt: 100 + 30 * 60000 })?.id).toBe('b')
    expect(route({ ...reply, createdAt: 101 + 30 * 60000 })?.id).toBe('a')
    expect(route(reply, [])?.id).toBe('a')
    expect(route({ ...reply, parentId: null })?.id).toBe('a')
    expect(route(reply, [{ ...user, meta: {} }], 'b')?.id).toBe('b')
  })
  test('位置包括 thread；同位置多 bot 可投递，account-shared 的其他位置不广播', () => {
    const target = route(reply, [{ ...user, meta: { clientMessageId: 'telegram:42:1', channelThread: 'topic' } }])!
    expect(target.id).toBe('c')
    expect(sameLocation(bindings[0]!, target)).toBe(false)
    expect(sameLocation(bindings[0]!, bindings[3]!)).toBe(true)
    expect(sameLocation(bindings[1]!, route()!)).toBe(true)
    expect(sameLocation(bindings[0]!, route()!)).toBe(false)
    expect(routeTarget(reply, [user], [], null, 200)).toBeNull()
  })
  test('解析入站 id 并保持 promptHint 只取本轮来源', () => {
    expect(parseInboundId('other.dm:location:with:colon:123')).toEqual({
      provider: 'other.dm',
      chat: 'location:with:colon',
    })
    expect(parseInboundId('web-uuid')).toBeNull()
    const hint = (p: string) => (p === 'other.dm' ? 'DM' : undefined)
    expect(promptHintFor('other.dm:u1:1', bindings, hint)).toBe('DM')
    expect(promptHintFor('other.dm:other:1', bindings, hint)).toBeUndefined()
    expect(promptHintFor('', bindings, hint)).toBeUndefined()
  })
})
