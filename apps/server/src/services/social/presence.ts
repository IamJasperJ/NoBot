import type { PresenceDTO, PresenceStatus } from '@nobot/shared'
import { eq } from 'drizzle-orm'
import { systemDatabase } from '../../db/system-client'
import { userPresencePrefs } from '../../db/system-schema'
import { liveHub } from '../live/hub'
import { friendIds } from './index'

interface State {
  connections: Map<string, number>
  disconnectedAt?: number
  lastActive: number
}
export class PresenceService {
  private states = new Map<string, State>()
  private published = new Map<string, PresenceStatus>()
  constructor(
    private clock = Date.now,
    private friends = friendIds,
  ) {}
  connect(userId: string, connectionId: string) {
    const now = this.clock()
    const state: State = this.states.get(userId) ?? { connections: new Map(), lastActive: now }
    state.connections.set(connectionId, now)
    state.lastActive = now
    state.disconnectedAt = undefined
    this.states.set(userId, state)
    this.tick()
  }
  disconnect(userId: string, connectionId: string) {
    const state = this.states.get(userId)
    if (!state?.connections.delete(connectionId)) return
    if (!state.connections.size) state.disconnectedAt = this.clock()
    this.tick()
  }
  activity(userId: string) {
    const state = this.states.get(userId)
    if (!state) return
    const now = this.clock()
    for (const id of state.connections.keys()) state.connections.set(id, now)
    state.lastActive = now
    this.tick()
  }
  private status(userId: string): PresenceStatus {
    const pref = systemDatabase()
      .select()
      .from(userPresencePrefs)
      .where(eq(userPresencePrefs.userId, userId))
      .get()?.status
    if (pref === 'invisible') return 'offline'
    const state = this.states.get(userId)
    const now = this.clock()
    if (!state || (!state.connections.size && now - (state.disconnectedAt ?? 0) >= 60000)) return 'offline'
    if (pref === 'dnd') return 'dnd'
    return now - state.lastActive < 300000 ? 'online' : 'away'
  }
  getPresence(
    viewer: string,
    ids: string[],
    visibleRoom?: (viewer: string, userId: string) => PresenceDTO['currentRoom'],
  ) {
    const allowed = new Set(this.friends(viewer))
    const result: Record<string, PresenceDTO> = {}
    for (const id of ids)
      if (allowed.has(id)) {
        const status = this.status(id)
        const room = status !== 'offline' ? visibleRoom?.(viewer, id) : undefined
        result[id] = { status, ...(room ? { currentRoom: room } : {}) }
      }
    return result
  }
  setPreference(userId: string, status: 'auto' | 'dnd' | 'invisible') {
    systemDatabase()
      .insert(userPresencePrefs)
      .values({ userId, status })
      .onConflictDoUpdate({ target: userPresencePrefs.userId, set: { status } })
      .run()
    this.tick()
  }
  tick() {
    for (const id of this.states.keys()) {
      const status = this.status(id)
      if (this.published.get(id) !== status) {
        this.published.set(id, status)
        liveHub.publishToUsers(this.friends(id), {
          type: 'presence',
          topic: `user:${id}`,
          data: { userId: id, presence: { status } },
        })
      }
      const state = this.states.get(id)!
      if (status === 'offline' && !state.connections.size && this.clock() - (state.disconnectedAt ?? 0) >= 60000) {
        this.states.delete(id)
        this.published.delete(id)
      }
    }
  }
}
export const presence = new PresenceService()
// 定时器只负责空闲和宽限期转换，不应阻止进程退出。
setInterval(() => presence.tick(), 1000).unref()
