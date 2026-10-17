import { pickSprite } from '@ai-parter/core/stage'
import type { CastMember, MessageDTO, PlayPresetData, StageState } from '@ai-parter/shared'
import { type RefObject, useEffect, useState } from 'react'
import { useSprites } from '../../api/queries'
import { cx } from '../../components/ui'
import { useAppearance } from '../../stores/appearance'
import type { ChatCast } from './MessageItem'

/**
 * 普通聊天视图里的侧边立绘（VN2）：显示最近说话的角色当前表情的立绘。
 * - 宽屏且对话区右边有足够空白时，立绘站在右侧空白里，脚底贴着输入框上沿
 * - 空白不够（窄屏、对话区铺满）或预设选了「顶部」时，缩成右上角一张半身小卡，不挡消息
 * 没有立绘时按预设用头像代替，或者不显示。
 */
export function SideSprite({
  stage,
  play,
  cast,
  lastReply,
  container,
}: {
  stage: StageState
  play: PlayPresetData
  cast: ChatCast
  lastReply: MessageDTO | null
  container: RefObject<HTMLElement | null>
}) {
  const actor = focusActor(stage.cast, lastReply)
  const sprites = useSprites(actor?.characterId)
  const free = useFreeSpace(container)
  if (!actor || play.sprites.sideSprite === 'off') return null

  const sprite = sprites.data
    ? pickSprite(sprites.data, {
        expression: actor.expression,
        outfit: actor.outfit ?? '',
        fallback: play.sprites.fallback,
        random: play.sprites.randomMultiple,
        seed: lastReply?.id ?? actor.key,
      })
    : null
  const avatar = actor.characterId ? cast.speakers[actor.characterId]?.avatarUrl : null
  const src = sprite?.url ?? (play.sprites.avatarFallback ? avatar : null)
  if (!src) return null
  const isAvatar = !sprite
  const side = play.sprites.sideSprite === 'right' && free >= 180 && !isAvatar

  return side ? (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute right-2 bottom-20 -z-10 hidden h-[min(72vh,760px)] md:block"
      style={{ width: Math.min(free - 16, 520) }}
    >
      <img
        key={src}
        src={src}
        alt=""
        className="side-sprite size-full object-contain object-bottom drop-shadow-[0_8px_24px_rgb(0_0_0/0.25)]"
      />
    </div>
  ) : (
    <div
      className="pointer-events-none fixed top-3 right-3 z-10 w-20 overflow-hidden rounded-xl border border-white/60 bg-white/70 shadow-md backdrop-blur md:absolute md:w-24 dark:border-zinc-700 dark:bg-zinc-900/70"
      title={`${actor.name}${actor.expression ? ` · ${actor.expression}` : ''}`}
    >
      <img
        key={src}
        src={src}
        alt={actor.name}
        className={cx('side-sprite aspect-[3/4] w-full', isAvatar ? 'object-cover' : 'object-cover object-top')}
      />
      <p className="truncate bg-white/80 px-1.5 py-0.5 text-center text-[11px] font-medium dark:bg-zinc-900/80">
        {actor.name}
      </p>
    </div>
  )
}

/** 该显示谁：最后一条回复的说话人在台上就是他；否则取台上第一个能对应到角色卡的人；再不行取台上第一个人 */
function focusActor(cast: CastMember[], lastReply: MessageDTO | null): CastMember | null {
  if (!cast.length) return null
  return (
    cast.find((m) => m.characterId && m.characterId === lastReply?.speakerId) ??
    cast.find((m) => m.characterId) ??
    cast[0] ??
    null
  )
}

/** 对话区右边还剩多少空白（像素）：容器宽度减去消息列宽度和左边距 */
function useFreeSpace(container: RefObject<HTMLElement | null>) {
  const chatWidth = useAppearance((s) => s.chatWidth)
  const chatAlign = useAppearance((s) => s.chatAlign)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = container.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    setWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [container])
  if (chatWidth === 0 || !width) return 0
  const column = Math.min(chatWidth, width - 32)
  return chatAlign === 'left' ? width - column - 16 : (width - column) / 2
}
