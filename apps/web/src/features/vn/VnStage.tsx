import { pickSprite } from '@ai-parter/core/stage'
import type { CastMember, PlayPresetData, SpriteDTO, StagePosition, StageState } from '@ai-parter/shared'
import { useQueries } from '@tanstack/react-query'
import { api } from '../../api/client'
import { keys } from '../../api/queries'
import { cx } from '../../components/ui'

/**
 * VN 的立绘层：台上的人按站位排开，脚底贴着对话框上沿。
 * - 正在说话的人在最上层、正常亮度；其他人按「非说话人变暗」变暗、略缩小（焦点模式，可关）
 * - 人数超过「最多同屏人数」时，只留最近说过话 / 最近上台的几个
 * - 没有立绘：按设置用角色卡头像（圆角卡片），或者临时 NPC 用剪影 + 名牌
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
  stage,
  play,
  speakerKey,
  avatars,
  seed,
  mobile,
}: {
  stage: StageState
  play: PlayPresetData
  speakerKey: string | null
  /** 角色 id → 头像地址（没有立绘时的兜底） */
  avatars: Record<string, string | null>
  /** 多张立绘时稳定随机的种子（用消息 id，同一条消息不会来回换图） */
  seed: string
  mobile: boolean
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
  const dim = play.stage.focus && speakerKey ? play.stage.dim / 100 : 0
  const scale = play.stage.spriteScale / 100

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {cast.map((m, i) => {
        const sprite = m.characterId
          ? pickSprite(byCharacter.get(m.characterId) ?? [], {
              expression: m.expression,
              outfit: m.outfit ?? '',
              fallback: play.sprites.fallback,
              random: play.sprites.randomMultiple,
              seed: `${seed}:${m.key}`,
            })
          : null
        const avatar = m.characterId ? avatars[m.characterId] : null
        const focused = !speakerKey || m.key === speakerKey
        if (!sprite && !(play.sprites.avatarFallback && avatar) && play.stage.unknownActor === 'hide') return null
        return (
          <div
            key={m.key}
            className="vn-actor absolute bottom-0 flex flex-col items-center"
            style={{
              left: `${spread(m, i)}%`,
              height: `${(mobile ? 62 : 88) * scale}%`,
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
                className="vn-fade h-full w-auto max-w-none object-contain object-bottom drop-shadow-[0_10px_30px_rgb(0_0_0/0.35)]"
              />
            ) : play.sprites.avatarFallback && avatar ? (
              <div className="vn-fade mb-[18%] flex flex-col items-center">
                <img
                  src={avatar}
                  alt=""
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
          </div>
        )
      })}
    </div>
  )
}
