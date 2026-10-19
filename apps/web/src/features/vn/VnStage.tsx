import type { CastMember, PlayPresetData, SpriteDTO, StagePosition, StageState } from '@nobot/shared'
import { useQueries } from '@tanstack/react-query'
import { type ReactNode, useMemo, useRef } from 'react'
import { api } from '../../api/client'
import { keys } from '../../api/queries'
import { cx } from '../../components/ui'
import { t } from '../../i18n'
import { type SpriteAdjust, useSpriteLayout } from '../../stores/spriteLayout'
import { useOpaqueBox } from './opaqueBox'
import { spriteGesture } from './spriteGesture'
import { usePreviousSprites } from './usePreviousSprites'

/**
 * VN 的立绘层：台上的人按站位排开，脚底贴着对话框上沿。
 * - 正在说话的人在最上层、正常亮度；其他人按「非说话人变暗」变暗、略缩小（焦点模式，可关）
 * - 人数超过「最多同屏人数」时，只留最近说过话 / 最近上台的几个
 * - 没有立绘：按设置用角色卡头像（圆角卡片），或者临时 NPC 用剪影 + 名牌
 * - 调整模式（adjusting）：拖动换位置、滚轮 / 双指捏合缩放，每个人头上有一个小工具条；结果按「会话 + 演员」存在本机
 */

/** 站位 → 横向位置（占舞台宽度的百分比） */
const POSITION: Record<string, number> = {
  left: 24,
  center: 50,
  right: 76,
  '1': 12,
  '2': 31,
  '3': 50,
  '4': 69,
  '5': 88,
}
const xOf = (at: StagePosition) => POSITION[String(at)] ?? 50

export function VnStage({
  chatId,
  stage,
  play,
  speakerKey,
  avatars,
  seed,
  beatKey,
  mobile,
  adjusting,
}: {
  chatId: string
  stage: StageState
  play: PlayPresetData
  speakerKey: string | null
  /** 角色 id → 头像地址（没有立绘时的兜底） */
  avatars: Record<string, string | null>
  /** 多张立绘时稳定随机的种子（用消息 id，同一条消息不会来回换图） */
  seed: string
  /** 当前这一拍（换拍时「重复表情换一张」才重新挑图） */
  beatKey: string
  mobile: boolean
  /** 正在调整立绘：可以拖动、缩放，不变暗 */
  adjusting: boolean
}) {
  const ids = [...new Set(stage.cast.flatMap((m) => (m.characterId ? [m.characterId] : [])))]
  const sprites = useQueries({
    queries: ids.map((id) => ({
      queryKey: keys.sprites(id),
      queryFn: () => api.listSprites(id),
      staleTime: 60_000,
    })),
  })
  const byCharacter = new Map<string, SpriteDTO[]>(ids.map((id, i) => [id, sprites[i]?.data ?? []]))
  const layout = useSpriteLayout((s) => s.vn[chatId])
  const outfits = useSpriteLayout((s) => s.outfits[chatId])
  const root = useRef<HTMLDivElement>(null)

  // 同屏人数：手机最多 2 人。超出时说话人一定在，其余按台上顺序从后往前留（后上台的更可能是当前场景的人）
  const limit = Math.max(1, Math.min(play.stage.maxCast, mobile ? 2 : 5))
  const speaking = stage.cast.find((m) => m.key === speakerKey)
  const others = stage.cast.filter((m) => m !== speaking)
  const visible = [...(speaking ? [speaking] : []), ...others.slice(-(limit - (speaking ? 1 : 0)))]
  const cast = stage.cast.filter((m) => visible.includes(m))
  // 同屏只剩一两个人时，挤在同一个站位上的人分开一点
  const spread = (m: CastMember, i: number) => {
    const x = xOf(m.at)
    const clash = cast.findIndex((o) => xOf(o.at) === x)
    return clash === i ? x : Math.min(88, x + 14 * (i - clash))
  }
  const dim = play.stage.focus && speakerKey && !adjusting ? play.stage.dim / 100 : 0
  const scale = (play.stage.spriteScale / 100) * (layout?.all ?? 1)

  const selectedSprites = usePreviousSprites<SpriteDTO>(
    chatId,
    beatKey,
    cast.map((m) => ({
      key: m.key,
      sprites: m.characterId ? (byCharacter.get(m.characterId) ?? []) : [],
      options: {
        expression: m.expression,
        // 手动选的服装（「+」菜单里切换）优先于剧情里写的
        outfit: (m.characterId ? outfits?.[m.characterId] : undefined) ?? m.outfit ?? '',
        fallback: play.sprites.fallback,
        random: play.sprites.randomMultiple,
        rerollSame: play.sprites.rerollSame,
        seed: `${seed}:${m.key}`,
      },
    })),
  )

  return (
    <div
      ref={root}
      aria-hidden={adjusting ? undefined : true}
      // 不裁剪：立绘往下拖或放大时，可以伸到对话框后面一直到画面底部（整个 VN 视图本身会裁掉超出画面的部分）
      className={cx('absolute inset-0', adjusting ? 'pointer-events-auto' : 'pointer-events-none')}
    >
      {cast.map((m, i) => {
        const sprite = selectedSprites[m.key] ?? null
        const avatar = m.characterId ? avatars[m.characterId] : null
        // 没有立绘集的演员：unknownActor = generate 时后端会给他生成一张临时立绘（spriteUrl）
        const generated = !sprite && m.spriteUrl ? m.spriteUrl : null
        const focused = !speakerKey || m.key === speakerKey || adjusting
        if (!sprite && !generated && !(play.sprites.avatarFallback && avatar) && play.stage.unknownActor === 'hide')
          return null
        const adjust = layout?.actors[m.key]
        return (
          <Actor
            key={m.key}
            chatId={chatId}
            actorKey={m.key}
            name={m.name}
            root={root}
            adjust={adjust}
            adjusting={adjusting}
            src={sprite?.url ?? generated ?? undefined}
            style={{
              left: `${adjust?.x ?? spread(m, i)}%`,
              bottom: `${-(adjust?.y ?? 0)}%`,
              height: `${(mobile ? 62 : 88) * scale * (adjust?.scale ?? 1)}%`,
              zIndex: focused ? 2 : 1,
              filter: focused ? undefined : `brightness(${1 - dim})`,
              transform: `translateX(-50%) scale(${focused ? 1 : 0.97})`,
              transformOrigin: 'bottom center',
            }}
          >
            {sprite ? (
              <img
                key={sprite.id}
                src={sprite.url}
                alt=""
                draggable={false}
                className="vn-fade h-full w-auto max-w-none object-contain object-bottom drop-shadow-[0_10px_30px_rgb(0_0_0/0.35)]"
              />
            ) : generated ? (
              <img
                key={generated}
                src={generated}
                alt=""
                draggable={false}
                className="vn-fade h-full w-auto max-w-none object-contain object-bottom drop-shadow-[0_10px_30px_rgb(0_0_0/0.35)]"
              />
            ) : play.sprites.avatarFallback && avatar ? (
              <div className="vn-fade mb-[18%] flex flex-col items-center">
                <img
                  src={avatar}
                  alt=""
                  draggable={false}
                  className={cx(
                    'aspect-[3/4] rounded-2xl border-2 border-white/70 object-cover shadow-xl',
                    mobile ? 'w-28' : 'w-44',
                  )}
                />
              </div>
            ) : (
              // 临时 NPC：剪影 + 名牌
              <div className="vn-fade flex h-full flex-col items-center justify-end">
                {/* 半透明浅色 + 描边：深色、浅色背景上都看得见 */}
                <svg viewBox="0 0 100 220" className="h-[78%] w-auto" aria-hidden="true">
                  <g fill="rgb(255 255 255 / 0.22)" stroke="rgb(255 255 255 / 0.55)" strokeWidth="1.5">
                    <ellipse cx="50" cy="42" rx="26" ry="30" />
                    <path d="M10 219 C10 120 25 82 50 82 C75 82 90 120 90 219 Z" />
                  </g>
                </svg>
                <span className="mb-3 rounded-full bg-black/55 px-2.5 py-0.5 text-xs text-white backdrop-blur-sm">
                  {m.name}
                </span>
              </div>
            )}
          </Actor>
        )
      })}
    </div>
  )
}

/** 一个演员：平时只是定位用的盒子；调整模式下可以拖动、缩放，头上有工具条 */
function Actor({
  chatId,
  actorKey,
  name,
  root,
  adjust,
  adjusting,
  src,
  style,
  children,
}: {
  chatId: string
  actorKey: string
  name: string
  root: React.RefObject<HTMLDivElement | null>
  adjust: SpriteAdjust | undefined
  adjusting: boolean
  /** 立绘图片地址：用来算图里人物实际占的区域，拖动框贴着人物画；头像 / 剪影时不传，框就是整个元素 */
  src?: string
  style: React.CSSProperties
  children: ReactNode
}) {
  const opaque = useOpaqueBox(src)
  const setActor = useSpriteLayout((s) => s.setActor)
  const resetActor = useSpriteLayout((s) => s.resetActor)
  const box = useRef<HTMLDivElement>(null)
  // 手势对象只建一次（拖动过程中会频繁重渲染，不能丢掉按下时记的状态）；回调里读最新的值
  const latest = useRef({ adjust, style })
  latest.current = { adjust, style }
  const start = useRef({ x: 50, y: 0, scale: 1 })
  const gesture = useMemo(
    () =>
      spriteGesture({
        onStart: () => {
          const { adjust: a, style: s } = latest.current
          start.current = { x: a?.x ?? Number.parseFloat(String(s.left)), y: a?.y ?? 0, scale: a?.scale ?? 1 }
        },
        onMove: (dx, dy) => {
          const rect = root.current?.getBoundingClientRect()
          if (!rect?.width || !rect.height) return
          setActor(chatId, actorKey, {
            x: Math.min(100, Math.max(0, start.current.x + (dx / rect.width) * 100)),
            y: Math.min(60, Math.max(-60, start.current.y + (dy / rect.height) * 100)),
          })
        },
        onPinch: (ratio) => setActor(chatId, actorKey, { scale: start.current.scale * ratio }),
        onWheel: (factor) => setActor(chatId, actorKey, { scale: (latest.current.adjust?.scale ?? 1) * factor }),
      }),
    [chatId, actorKey, root, setActor],
  )
  const percent = Math.round((adjust?.scale ?? 1) * 100)

  return (
    <div
      ref={box}
      className={cx('vn-actor absolute flex flex-col items-center', adjusting && 'vn-actor-adjusting')}
      style={style}
    >
      {/* 包一层和图片一样大的盒子，拖动框按图里人物实际占的区域（去掉透明边）定位 */}
      <div className="relative h-full w-fit">
        {children}
        {adjusting && (
          <div
            className="absolute cursor-grab touch-none rounded-lg outline-2 outline-white/60 outline-dashed active:cursor-grabbing"
            style={{
              left: `${opaque.left * 100}%`,
              top: `${opaque.top * 100}%`,
              width: `${(opaque.right - opaque.left) * 100}%`,
              height: `${(opaque.bottom - opaque.top) * 100}%`,
            }}
            {...gesture}
          >
            <ActorToolbar
              name={name}
              percent={percent}
              onSmaller={() => setActor(chatId, actorKey, { scale: (adjust?.scale ?? 1) / 1.1 })}
              onLarger={() => setActor(chatId, actorKey, { scale: (adjust?.scale ?? 1) * 1.1 })}
              onReset={() => resetActor(chatId, actorKey)}
            />
          </div>
        )}
      </div>
    </div>
  )
}

/** 拖动框上方的工具条：名字、缩放比例、放大缩小、恢复；按下它不触发拖动 */
function ActorToolbar({
  name,
  percent,
  onSmaller,
  onLarger,
  onReset,
}: {
  name: string
  percent: number
  onSmaller: () => void
  onLarger: () => void
  onReset: () => void
}) {
  return (
    <div
      className="vn-chip absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 items-center gap-0.5 rounded-full px-1 py-0.5 text-[11px] whitespace-nowrap"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="max-w-24 truncate px-1.5 font-medium">{name}</span>
      <ToolButton label={t('缩小')} onClick={onSmaller}>
        −
      </ToolButton>
      <span className="w-9 text-center tabular-nums">{percent}%</span>
      <ToolButton label={t('放大')} onClick={onLarger}>
        +
      </ToolButton>
      <ToolButton label={t('恢复这个立绘的默认位置和大小')} onClick={onReset}>
        ↺
      </ToolButton>
    </div>
  )
}

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="flex size-6 items-center justify-center rounded-full text-sm hover:bg-white/15"
    >
      {children}
    </button>
  )
}
