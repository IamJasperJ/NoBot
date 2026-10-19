import { pickSprite, type SpriteCandidate } from '@nobot/core/stage'
import { useState } from 'react'

type Options = Parameters<typeof pickSprite>[1]
export interface SpriteRequest<T extends SpriteCandidate> {
  key: string
  sprites: T[]
  options: Omit<Options, 'previousId'>
}

/** 按会话、演员记住上一张；同一拍的普通重渲染不重新抽图，换拍才允许换图。 */
export function usePreviousSprites<T extends SpriteCandidate>(
  chatId: string,
  beatKey: string,
  requests: SpriteRequest<T>[],
): Record<string, T | null> {
  const signature = JSON.stringify([chatId, beatKey, requests])
  const [saved, setSaved] = useState<{
    chatId: string
    signature: string
    previous: Record<string, string>
    selected: Record<string, T | null>
    actors: Record<string, { signature: string; sprite: T | null }>
  }>({ chatId, signature: '', previous: {}, selected: {}, actors: {} })
  if (saved.signature === signature) return saved.selected
  const previous = saved.chatId === chatId ? { ...saved.previous } : {}
  const actors = saved.chatId === chatId ? { ...saved.actors } : {}
  const selected: Record<string, T | null> = {}
  for (const request of requests) {
    const actorSignature = JSON.stringify([beatKey, request])
    const cached = actors[request.key]
    const sprite =
      cached?.signature === actorSignature
        ? cached.sprite
        : pickSprite(request.sprites, { ...request.options, previousId: previous[request.key] })
    actors[request.key] = { signature: actorSignature, sprite }
    selected[request.key] = sprite
    if (sprite) previous[request.key] = sprite.id
  }
  // 派生状态在同一次渲染内更新，避免 effect 记下上一张后触发再次抽图。
  setSaved({ chatId, signature, previous, selected, actors })
  return selected
}
