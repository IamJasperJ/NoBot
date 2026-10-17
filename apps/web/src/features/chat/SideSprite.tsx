import { pickSprite } from '@ai-parter/core/stage'
import type { CastMember, MessageDTO, PlayPresetData, StageState } from '@ai-parter/shared'
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { useSprites } from '../../api/queries'
import { cx } from '../../components/ui'
import { t } from '../../i18n'
import { useAppearance } from '../../stores/appearance'
import { useChatOps } from '../../stores/chatOps'
import { useSpriteLayout } from '../../stores/spriteLayout'
import { useOpaqueBox } from '../vn/opaqueBox'
import { spriteGesture } from '../vn/spriteGesture'
import type { ChatCast } from './MessageItem'

/**
 * 普通聊天视图里的侧边立绘（VN2）：显示最近说话的角色当前表情的立绘。
 * - 宽屏且对话区右边有足够空白时，立绘站在右侧空白里，脚底贴着输入框上沿
 * - 空白不够（窄屏、对话区铺满）或预设选了「顶部」时，缩成右上角一张半身小卡，不挡消息
 * - 「+」菜单里「调整侧边立绘」：可以拖动位置、滚轮 / 双指缩放，按角色记在本机（x、y 是像素偏移）
 * - 「+」菜单里「切换立绘套装」选的服装优先于剧情里写的
 * 没有立绘时按预设用头像代替，或者不显示。
 */
export function SideSprite({
  chatId,
  stage,
  play,
  cast,
  lastReply,
  container,
}: {
  chatId: string
  stage: StageState
  play: PlayPresetData
  cast: ChatCast
  lastReply: MessageDTO | null
  container: RefObject<HTMLElement | null>
}) {
  const actor = focusActor(stage.cast, lastReply)
  const sprites = useSprites(actor?.characterId)
  const free = useFreeSpace(container)
  const manualOutfit = useSpriteLayout((s) => (actor?.characterId ? s.outfits[chatId]?.[actor.characterId] : undefined))
  const adjust = useSpriteLayout((s) => (actor?.characterId ? s.side[actor.characterId] : undefined))
  const setSide = useSpriteLayout((s) => s.setSide)
  const resetSide = useSpriteLayout((s) => s.resetSide)
  const adjusting = useChatOps((s) => s.sideAdjusting === chatId)
  const stopAdjusting = () => useChatOps.getState().setSideAdjusting(null)

  // 手势对象只建一次，回调里读最新的值
  const latest = useRef({ adjust, characterId: actor?.characterId })
  latest.current = { adjust, characterId: actor?.characterId }
  const start = useRef({ x: 0, y: 0, scale: 1 })
  const gesture = useMemo(
    () =>
      spriteGesture({
        onStart: () => {
          const a = latest.current.adjust
          start.current = { x: a?.x ?? 0, y: a?.y ?? 0, scale: a?.scale ?? 1 }
        },
        onMove: (dx, dy) => {
          const id = latest.current.characterId
          if (id) setSide(id, { x: start.current.x + dx, y: start.current.y + dy })
        },
        onPinch: (ratio) => {
          const id = latest.current.characterId
          if (id) setSide(id, { scale: start.current.scale * ratio })
        },
        onWheel: (factor) => {
          const id = latest.current.characterId
          if (id) setSide(id, { scale: (latest.current.adjust?.scale ?? 1) * factor })
        },
      }),
    [setSide],
  )

  // Esc 退出调整
  useEffect(() => {
    if (!adjusting) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useChatOps.getState().setSideAdjusting(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [adjusting])

  const sprite =
    actor && sprites.data
      ? pickSprite(sprites.data, {
          expression: actor.expression,
          outfit: manualOutfit ?? actor.outfit ?? '',
          fallback: play.sprites.fallback,
          random: play.sprites.randomMultiple,
          seed: lastReply?.id ?? actor.key,
        })
      : null
  // 图里人物实际占的区域：拖动框贴着人物画（hook 要放在下面的提前返回之前）
  const opaque = useOpaqueBox(sprite?.url)
  if (!actor || play.sprites.sideSprite === 'off') return null

  const avatar = actor.characterId ? cast.speakers[actor.characterId]?.avatarUrl : null
  const src = sprite?.url ?? (play.sprites.avatarFallback ? avatar : null)
  if (!src) return null
  const isAvatar = !sprite
  const side = play.sprites.sideSprite === 'right' && free >= 180 && !isAvatar
  const scale = adjust?.scale ?? 1
  const transform = `translate(${adjust?.x ?? 0}px, ${adjust?.y ?? 0}px) scale(${scale})`
  const editable = adjusting && !!actor.characterId

  // 工具条：侧边大立绘放在头顶；右上角小卡放在卡片下面（卡片贴着屏幕顶，上面放不下）
  const toolbar = editable && (
    <div
      className={cx(
        'absolute z-10 flex items-center gap-0.5 rounded-full border border-zinc-200 bg-white/95 px-1 py-0.5 text-xs whitespace-nowrap shadow-md dark:border-zinc-700 dark:bg-zinc-900/95',
        side ? '-top-11 left-1/2' : 'top-full right-0 mt-2',
      )}
      onPointerDown={(e) => e.stopPropagation()}
      // 工具条跟着立绘一起缩放会忽大忽小，这里反向缩放保持正常大小
      style={
        side
          ? { transform: `translateX(-50%) scale(${1 / scale})`, transformOrigin: 'bottom center' }
          : { transform: `scale(${1 / scale})`, transformOrigin: 'top right' }
      }
    >
      <span className="max-w-24 truncate px-1.5 font-medium">{actor.name}</span>
      <SmallButton label={t('缩小')} onClick={() => setSide(actor.characterId as string, { scale: scale / 1.1 })}>
        −
      </SmallButton>
      <span className="w-9 text-center tabular-nums">{Math.round(scale * 100)}%</span>
      <SmallButton label={t('放大')} onClick={() => setSide(actor.characterId as string, { scale: scale * 1.1 })}>
        +
      </SmallButton>
      <SmallButton label={t('恢复这个立绘的默认位置和大小')} onClick={() => resetSide(actor.characterId as string)}>
        ↺
      </SmallButton>
      <button
        type="button"
        onClick={stopAdjusting}
        className="ml-0.5 rounded-full bg-violet-600 px-2.5 py-0.5 text-white hover:bg-violet-500"
      >
        {t('完成')}
      </button>
    </div>
  )
  const adjustClass = editable
    ? 'pointer-events-auto z-20 cursor-grab touch-none rounded-xl outline-2 outline-violet-400 outline-dashed active:cursor-grabbing'
    : 'pointer-events-none'

  // 侧边大立绘：按立绘原图的宽高比算出框的大小（高不超过 72vh / 760px，宽不超过右侧空白和 520px），图片正好铺满，没有留白
  let boxW = 0
  let boxH = 0
  if (side && sprite) {
    const aspect = sprite.width > 0 && sprite.height > 0 ? sprite.width / sprite.height : 0.6
    boxH = Math.min(window.innerHeight * 0.72, 760, Math.max(0, Math.min(free - 16, 520)) / aspect)
    boxW = boxH * aspect
  }

  return side ? (
    <div
      aria-hidden={editable ? undefined : true}
      className={cx('pointer-events-none absolute right-2 bottom-20 hidden md:block', editable ? 'z-20' : '-z-10')}
      style={{ width: boxW, height: boxH, transform, transformOrigin: 'bottom center' }}
    >
      <img
        key={src}
        src={src}
        alt=""
        draggable={false}
        className="side-sprite size-full object-contain object-bottom drop-shadow-[0_8px_24px_rgb(0_0_0/0.25)]"
      />
      {editable && (
        <div
          className={cx('absolute', adjustClass)}
          style={{
            left: `${opaque.left * 100}%`,
            top: `${opaque.top * 100}%`,
            width: `${(opaque.right - opaque.left) * 100}%`,
            height: `${(opaque.bottom - opaque.top) * 100}%`,
          }}
          {...gesture}
        >
          {toolbar}
        </div>
      )}
    </div>
  ) : (
    <div
      className={cx(
        'fixed top-3 right-3 z-10 w-20 rounded-xl border border-white/60 bg-white/70 shadow-md backdrop-blur md:absolute md:w-24 dark:border-zinc-700 dark:bg-zinc-900/70',
        adjustClass,
      )}
      style={{ transform, transformOrigin: 'top right' }}
      title={`${actor.name}${actor.expression ? ` · ${actor.expression}` : ''}`}
      {...(editable ? gesture : {})}
    >
      {toolbar}
      <div className="overflow-hidden rounded-xl">
        <img
          key={src}
          src={src}
          alt={actor.name}
          draggable={false}
          className={cx('side-sprite aspect-[3/4] w-full', isAvatar ? 'object-cover' : 'object-cover object-top')}
        />
        <p className="truncate bg-white/80 px-1.5 py-0.5 text-center text-[11px] font-medium dark:bg-zinc-900/80">
          {actor.name}
        </p>
      </div>
    </div>
  )
}

function SmallButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded-full text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
    >
      {children}
    </button>
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
