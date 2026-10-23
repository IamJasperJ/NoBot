import type { LiveEnvelope } from '@nobot/shared'

export class LiveHub {
  private connections = new Set<{
    userId: string
    topics: Set<string>
    send: (event: LiveEnvelope) => void
    close: () => void
  }>()
  register(userId: string, send: (event: LiveEnvelope) => void, close: () => void) {
    const connection = { userId, topics: new Set([`user:${userId}`]), send, close }
    this.connections.add(connection)
    return {
      // 每次加入都重新鉴权；MP2 应在踢人后同步撤销已有订阅。
      join: async (topic: string, authorize: (userId: string, topic: string) => boolean | Promise<boolean>) => {
        if (topic.startsWith('user:') || !(await authorize(userId, topic)) || !this.connections.has(connection))
          return false
        connection.topics.add(topic)
        return true
      },
      dispose: () => this.connections.delete(connection),
    }
  }
  publishToUser(userId: string, event: LiveEnvelope) {
    this.publishToUsers([userId], event)
  }
  publishToUsers(ids: Iterable<string>, event: LiveEnvelope) {
    const allowed = new Set(ids)
    for (const c of this.connections) if (allowed.has(c.userId)) c.send(event)
  }
  publishToTopic(topic: string, event: LiveEnvelope, filter?: (userId: string) => boolean) {
    for (const c of this.connections) if (c.topics.has(topic) && (!filter || filter(c.userId))) c.send(event)
  }
  disconnectUserFromTopic(userId: string, topic: string) {
    for (const c of this.connections) if (c.userId === userId) c.topics.delete(topic)
  }
  closeUser(userId: string) {
    for (const c of this.connections)
      if (c.userId === userId) {
        this.connections.delete(c)
        c.close()
      }
  }
}
export const liveHub = new LiveHub()
