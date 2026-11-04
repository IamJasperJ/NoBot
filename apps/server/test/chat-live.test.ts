import { expect, test } from 'bun:test'
import type { LiveEnvelope, MessageDTO } from '@nobot/shared'
import { emitServerEvent } from '../src/extensions/registry'
import { liveHub } from '../src/services/live/hub'
import { currentUser } from '../src/user-context'

test('后台写入消息和生成结束会通知网页刷新会话，普通更新不通知', () => {
  const received: LiveEnvelope[] = []
  const handle = liveHub.register(
    currentUser().id,
    (event) => received.push(event),
    () => {},
  )
  try {
    const message = { id: 'm1', chatId: 'c1' } as MessageDTO
    emitServerEvent({ type: 'message:saved', message })
    emitServerEvent({ type: 'message:updated', message })
    emitServerEvent({ type: 'message:deleted', chatId: 'c2', messageIds: ['m2'] })
    emitServerEvent({ type: 'generation:complete', chatId: 'c3' })
    expect(received.filter((e) => e.type === 'chat.changed').map((e) => e.data)).toEqual([
      { chatId: 'c1' },
      { chatId: 'c2' },
      { chatId: 'c3' },
    ])
  } finally {
    handle.dispose()
  }
})
