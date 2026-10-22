import type { PlayPresetData } from '@nobot/shared'
import { type ReactNode, useEffect, useRef } from 'react'
import {
  BookmarkIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeOffIcon,
  FilmIcon,
  ImageIcon,
  LogIcon,
  MoveIcon,
  XIcon,
} from '../../components/icons'
import { Slot } from '../../extensions/Slot'
import { t } from '../../i18n'
import { useVn } from '../../stores/vn'
import type { useVnPlayer } from './useVnPlayer'
import type { useVnImages } from './VnImages'
import { Dot, VnButton } from './VnParts'

/** 一个开关面板：当前是否打开 + 切换 */
interface Toggle {
  on: boolean
  set: (on: boolean) => void
}

/**
 * VN 顶部：场景信息、状态面板胶囊和右上角操作栏。
 * 操作栏默认收起，只留「展开」和「关闭」；展开后鼠标离开或停留不动 4 秒自动收回（调整立绘时保持展开）。
 */
export function VnToolbar({
  chatId,
  play,
  player,
  images,
  scene,
  cinema,
  hudLeft,
  hudRight,
  tools,
  adjusting,
  saves,
  backlog,
  onHide,
}: {
  chatId: string
  play: PlayPresetData
  player: ReturnType<typeof useVnPlayer>
  images: ReturnType<typeof useVnImages>
  scene: { place?: string | null; time?: string | null }
  cinema: boolean
  /** 宽屏状态面板放在左上角 / 操作栏前面时的胶囊 */
  hudLeft?: ReactNode
  hudRight?: ReactNode
  /** 操作栏展开状态放在父组件：点画面时要收起它 */
  tools: Toggle
  adjusting: Toggle
  saves: Toggle
  backlog: Toggle
  onHide: () => void
}) {
  const setMode = useVn((s) => s.setMode)
  const toggleCinema = useVn((s) => s.toggleCinema)
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const armCollapse = () => {
    clearTimeout(collapseTimer.current)
    collapseTimer.current = setTimeout(() => tools.set(false), 4000)
  }
  // 鼠标在操作栏上时不收起：点「展开」时鼠标本来就在栏里，不会再触发进入事件，所以单独记着
  const hovering = useRef(false)
  useEffect(() => {
    if (tools.on && !hovering.current) armCollapse()
    return () => clearTimeout(collapseTimer.current)
  }, [tools.on])
  const showTools = tools.on || adjusting.on

  return (
    <div className="relative z-10 flex items-start gap-2 p-3 pl-14 md:pl-3">
      {!cinema && (scene.place || scene.time) && (
        <div className="vn-chip max-w-[45%] truncate rounded-full px-3 py-1 text-xs">
          {[scene.place, scene.time].filter(Boolean).join(' · ')}
        </div>
      )}
      {hudLeft}
      {/* 手机上展开后按钮可能一行放不下：工具组自动换行、靠右对齐，展开 / 关闭按钮留在第一行两端 */}
      <div
        className="ml-auto flex min-w-0 flex-1 items-start justify-end gap-1"
        onPointerEnter={() => {
          hovering.current = true
          clearTimeout(collapseTimer.current)
        }}
        onPointerLeave={() => {
          hovering.current = false
          if (showTools) armCollapse()
        }}
      >
        {hudRight}
        <VnButton
          label={showTools ? t('收起操作栏') : t('展开操作栏')}
          active={showTools}
          onClick={() => tools.set(!showTools)}
        >
          {showTools ? <ChevronRightIcon /> : <ChevronLeftIcon />}
          {/* 收起时用小圆点提示：有新图片、正在自动播放或快进 */}
          {!showTools && (images.pending || images.unread || player.auto || player.skip) && (
            <Dot pulse={images.pending} />
          )}
        </VnButton>
        {showTools && (
          <div className="vn-tools-in flex min-w-0 flex-wrap items-center justify-end gap-1">
            {images.latest && (
              <VnButton label={images.open ? t('收起图片') : t('图片')} active={images.open} onClick={images.toggle}>
                <ImageIcon />
                {(images.pending || images.unread) && <Dot pulse={images.pending} />}
              </VnButton>
            )}
            {play.stage.draggable && (
              <VnButton
                label={adjusting.on ? t('完成调整') : t('调整立绘（拖动位置、滚轮缩放）')}
                active={adjusting.on}
                onClick={() => adjusting.set(!adjusting.on)}
              >
                <MoveIcon />
              </VnButton>
            )}
            <VnButton label={t('存档 / 读档')} active={saves.on} onClick={() => saves.set(!saves.on)}>
              <BookmarkIcon />
            </VnButton>
            <VnButton label={t('回想')} active={backlog.on} onClick={() => backlog.set(!backlog.on)}>
              <LogIcon />
            </VnButton>
            <Slot name="vn.toolbar" props={{ chatId, play }} />
            <VnButton
              label={player.auto ? t('停止自动播放') : t('自动播放')}
              active={player.auto}
              onClick={() => player.setAuto(!player.auto)}
            >
              <span className="text-[11px] font-semibold">AUTO</span>
            </VnButton>
            <VnButton
              label={play.dialog.skipReadOnly ? t('快进（只跳过读过的）') : t('快进')}
              active={player.skip}
              onClick={() => player.setSkip(!player.skip)}
            >
              <span className="text-[11px] font-semibold">SKIP</span>
            </VnButton>
            <VnButton
              label={cinema ? t('退出电影模式') : t('电影模式（上下黑边，只留字幕）')}
              active={cinema}
              onClick={() => toggleCinema(chatId, play.stage.letterbox)}
            >
              <FilmIcon />
            </VnButton>
            <VnButton label={t('隐藏界面（点画面恢复）')} onClick={onHide}>
              <EyeOffIcon />
            </VnButton>
          </div>
        )}
        <VnButton label={t('回到聊天视图')} onClick={() => setMode(chatId, 'chat')}>
          <XIcon />
        </VnButton>
      </div>
    </div>
  )
}
