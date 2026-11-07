/** 同一会话绑了多个平台时的规则：默认消息走主渠道，渠道发来的请求只回到来源位置；平台提示只取本轮来源。 */

/** 渠道入站消息的 clientMessageId 固定为「平台:位置:消息 id」；位置里可能有冒号，消息 id 取最后一段。 */
export function parseInboundId(id: string): { provider: string; chat: string } | null {
  const first = id.indexOf(':')
  const last = id.lastIndexOf(':')
  if (first <= 0 || last <= first) return null
  return { provider: id.slice(0, first), chat: id.slice(first + 1, last) }
}

export interface RouteBinding {
  id: string
  provider: string
  chat: string
  thread: string
  state: string
}
export interface RouteMessage {
  id: string
  parentId: string | null
  role: string
  createdAt: number
  meta: { clientMessageId?: unknown; channelThread?: unknown }
}

/** 列表按创建顺序传入；主绑定失效时回退到最早的 active 绑定。 */
export function primaryBinding<T extends { id: string; state: string }>(bindings: T[], primaryId?: string | null) {
  return bindings.find((b) => b.id === primaryId && b.state === 'active') ?? bindings.find((b) => b.state === 'active')
}

export function sameLocation(a: RouteBinding, b: Pick<RouteBinding, 'provider' | 'chat' | 'thread'>) {
  return a.provider === b.provider && a.chat === b.chat && a.thread === b.thread
}

/** 只沿实际父链找最近的 user；网页用户消息是否镜像由调用方的设置决定。 */
export function routeTarget(
  message: RouteMessage,
  parents: RouteMessage[],
  bindings: RouteBinding[],
  primaryId: string | null | undefined,
  now: number,
): RouteBinding | null {
  const primary = primaryBinding(bindings, primaryId) ?? null
  if (message.role === 'user') return parseInboundId(String(message.meta.clientMessageId ?? '')) ? null : primary
  const byId = new Map(parents.map((p) => [p.id, p]))
  const seen = new Set<string>()
  let parent = message.parentId ? byId.get(message.parentId) : undefined
  while (parent && parent.role !== 'user' && !seen.has(parent.id)) {
    seen.add(parent.id)
    parent = parent.parentId ? byId.get(parent.parentId) : undefined
  }
  if (parent?.role !== 'user' || (message.createdAt ?? now) - parent.createdAt > 30 * 60000) return primary
  const source = parseInboundId(String(parent.meta.clientMessageId ?? ''))
  if (!source) return primary
  // 入站 id 不含 thread，新消息另存 thread；旧消息没有记录时按创建顺序匹配。
  return (
    bindings.find(
      (b) =>
        b.provider === source.provider &&
        b.chat === source.chat &&
        (typeof parent.meta.channelThread !== 'string' || b.thread === parent.meta.channelThread),
    ) ?? primary
  )
}

/** 只取本轮来源平台的提示：最近一条用户消息来自哪个绑定就用哪个平台的；网页发的不加。 */
export function promptHintFor(
  clientMessageId: string,
  bindings: { provider: string; chat: string }[],
  hintOf: (provider: string) => string | undefined,
) {
  const source = parseInboundId(clientMessageId)
  if (!source || !bindings.some((b) => b.provider === source.provider && b.chat === source.chat)) return undefined
  return hintOf(source.provider)
}
