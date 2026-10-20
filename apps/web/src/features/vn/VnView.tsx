import { toDisplayText } from '@nobot/core/stage'
import type { ChoiceOption, GroupDTO, MessageDTO, PlayPresetData, StateSchema } from '@nobot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api/client'
import { refreshChatState, resetChat } from '../../api/queries'
import { useFreshDice, usePickChoice, useTrpgSettings } from '../../api/trpg'
import {
  BookmarkIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeOffIcon,
  FilmIcon,
  ImageIcon,
  LogIcon,
  MoveIcon,
  RefreshIcon,
  XIcon,
} from '../../components/icons'
import { cx } from '../../components/ui'
import { Slot } from '../../extensions/Slot'
import { useMobile } from '../../hooks/useMobile'
import { t } from '../../i18n'
import { useSpriteLayout } from '../../stores/spriteLayout'
import { errorMessage, toast } from '../../stores/toast'
import { useCinema, useVn } from '../../stores/vn'
import { Composer } from '../chat/Composer'
import { displayMacros } from '../chat/format'
import { runGeneration } from '../chat/generate'
import type { ChatCast } from '../chat/MessageItem'
import { CheckCard, DiceCard } from '../trpg/DiceCard'
import { InitiativeBar } from '../trpg/InitiativeBar'
import { checkSkillLabel } from '../trpg/labels'
import { useCgRefresh } from './useCgRefresh'
import { useVnPlayer } from './useVnPlayer'
import { VnHud } from './VnHud'
import { useVnImages, VnImageCard } from './VnImages'
import { VnSaves } from './VnSaves'
import { VnStage } from './VnStage'

/**
 * VN 视图（VN3）：同一条聊天的「舞台视图」。背景沿用应用底层的背景层，这里画立绘、对话框和操作。
 *
 * 版式：
 * - ADV：底部对话框 + 名牌，立绘站在对话框上方
 * - NVL：半透明全屏文本，适合大段旁白；「自动」版式下旁白超过设定字数时这一拍用 NVL
 *
 * 操作：点画面 / 空格 / 回车推进；顶部有回想、自动、快进、隐藏界面、回到聊天视图。
 * 一条回复演完后，底部出现选项按钮和输入框（和聊天视图共用同一个输入框组件）。
 */
export function VnView({
  chatId,
  messages,
  play,
  cast,
  group,
  busy,
  liveVars,
  stateSchema,
}: {
  chatId: string
  messages: MessageDTO[]
  play: PlayPresetData
  cast: ChatCast
  group: GroupDTO | null
  busy: boolean
  /** 会话当前的变量（整条激活路径算出来的） */
  liveVars: Record<string, unknown>
  /** 生效的状态定义（预设 + 角色卡合并后），HUD 按它显示 */
  stateSchema: StateSchema
}) {
  const mobile = useMobile()
  const qc = useQueryClient()
  const setMode = useVn((s) => s.setMode)
  const knownNames = cast.stage?.knownNames ?? Object.values(cast.speakers).map((s) => s.name)
  const members = useMemo(() => Object.entries(cast.speakers).map(([id, s]) => ({ id, name: s.name })), [cast.speakers])
  const player = useVnPlayer({ chatId, messages, play, knownNames, members })
  const [hidden, setHidden] = useState(false)
  const [backlog, setBacklog] = useState(false)
  const { beat, current, ended } = player
  const images = useVnImages(messages)
  const [saves, setSaves] = useState(false)
  // 电影模式：上下黑边、只留字幕；默认跟玩法预设，工具栏可以临时切换（只记在这次打开的页面里）
  const cinema = useCinema(chatId, play.stage.letterbox)
  const toggleCinema = useVn((s) => s.toggleCinema)
  // 这条回复的 CG 还在画：定时刷新会话，画好后自动显示
  useCgRefresh(chatId, current)
  // 转场时长给 CSS 用（立绘进出场、CG 淡入）；「无」就是 0
  const transitionMs = play.stage.transition === 'none' ? 0 : play.stage.transitionMs
  // 调整立绘：拖动位置、缩放（玩法预设「允许拖动立绘」开着时才有这个入口）
  const [adjusting, setAdjusting] = useState(false)
  // 右上角操作栏默认收起，只留「展开」和「关闭」；展开后鼠标离开或停留不动 4 秒自动收回（调整立绘时保持展开）
  const [toolsOpen, setToolsOpen] = useState(false)
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const armCollapse = () => {
    clearTimeout(collapseTimer.current)
    collapseTimer.current = setTimeout(() => setToolsOpen(false), 4000)
  }
  // 鼠标在操作栏上时不收起：点「展开」时鼠标本来就在栏里，不会再触发进入事件，所以单独记着
  const hovering = useRef(false)
  useEffect(() => {
    if (toolsOpen && !hovering.current) armCollapse()
    return () => clearTimeout(collapseTimer.current)
  }, [toolsOpen])
  const showTools = toolsOpen || adjusting

  // HUD 的变量：跟着最新回复且演完了，就是会话当前的变量；
  // 正在演（或重演旧回复）时是这条回复之前的变量，演完再加上这条的补丁——好感 +3 在回复演完时飘出来
  const hudVars = useMemo(() => {
    if (!player.pinned && ended) return liveVars
    const vars = { ...(player.varsBefore ?? liveVars) }
    if (ended && current) {
      for (const patch of [current.meta.varsPatch, current.meta.varsManual]) {
        for (const [key, value] of Object.entries(patch ?? {})) {
          if (value === null) delete vars[key]
          else vars[key] = value
        }
      }
    }
    return vars
  }, [player.pinned, ended, liveVars, player.varsBefore, current])
  const showHud = play.interaction.hud && Object.keys(stateSchema).length > 0
  const hudBar = mobile || play.interaction.hudPosition === 'top-bar'
  // 宽屏的状态面板收成操作栏里的一枚胶囊；存档、回想、电影模式时不显示
  const inlineHud = showHud && !hudBar && !cinema && !saves && !backlog
  const editVar = async (key: string, value: unknown) => {
    try {
      await api.setVars(chatId, { [key]: value })
      await refreshChatState(qc, chatId)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const avatars = Object.fromEntries(Object.entries(cast.speakers).map(([id, s]) => [id, s.avatarUrl]))
  // 跑团：选项检定、刚掷出的骰子演出、战斗先攻条
  const trpg = useTrpgSettings(chatId)
  const pickChoice = usePickChoice(chatId)
  const lastRoll = messages.findLast((m) => m.role === 'tool' && (m.meta.dice || m.meta.check))
  const rollFresh = useFreshDice(lastRoll?.id ?? '', trpg.diceMs + 1500)
  const combat = player.stage.combat
  const avatarOf = (who: { name: string; characterId?: string | null }) =>
    who.characterId
      ? (cast.speakers[who.characterId]?.avatarUrl ?? null)
      : who.name === cast.user.name || who.name.toLowerCase() === 'player'
        ? cast.user.avatarUrl
        : (Object.values(cast.speakers).find((s) => s.name === who.name)?.avatarUrl ?? null)
  const choices: ChoiceOption[] | undefined =
    beat?.kind === 'choices' ? beat.options : ended && !player.pinned ? current?.meta.stage?.choices : undefined
  const scene = player.stage.scene
  // 选项排列：自动 = 选项少且都短时横排，否则竖排
  const choiceRow =
    play.interaction.choiceLayout === 'row' ||
    (play.interaction.choiceLayout === 'auto' &&
      !!choices &&
      choices.length <= 3 &&
      choices.every((c) => Array.from(c.text).length <= 12))

  // 切换备选回复 / 备选开场白、重新生成：和聊天视图的规则一样——
  // 只有最后一条回复能重新生成（开场白没有父消息，只能在备选开场白之间切换）；重演旧回复时不显示
  const canRegenerate = !!current && current.parentId !== null && messages.at(-1)?.id === current.id
  const showSwipes =
    !!current && !player.pinned && !busy && !player.streaming && (current.swipeCount > 1 || canRegenerate)
  const regenerate = () => {
    if (!current) return
    void runGeneration(qc, chatId, { mode: 'regenerate', targetId: current.id }).catch((e) =>
      toast.error(errorMessage(e)),
    )
  }
  const swipe = async (direction: -1 | 1) => {
    if (!current) return
    if (direction === 1 && current.swipeIndex === current.swipeCount) {
      if (canRegenerate) regenerate()
      return
    }
    try {
      await api.swipe(chatId, { messageId: current.id, direction })
      await resetChat(qc, chatId)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  // 版式：NVL 全屏文本，或「自动」时的长旁白
  const nvl =
    beat?.kind !== 'choices' &&
    (play.basic.layout === 'nvl' ||
      (play.basic.layout === 'auto' &&
        beat?.kind === 'narration' &&
        Array.from(beat.text).length > play.basic.nvlThreshold))

  // 键盘：空格 / 回车 / → 推进，← 回退（焦点在输入框里时不抢）；Esc 关回想、恢复隐藏的界面
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (e.key === 'Escape') {
        setBacklog(false)
        setHidden(false)
        setAdjusting(false)
        return
      }
      if (adjusting) return
      if (e.key === 'ArrowLeft' && !backlog && !hidden) {
        e.preventDefault()
        player.back()
        return
      }
      // 空格 / 回车 / → 推进（→ 和 ← 回退成对）
      if ((e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') && !backlog) {
        e.preventDefault()
        if (hidden) setHidden(false)
        else player.advance()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [player.advance, player.back, backlog, hidden, adjusting])

  const said = player.said
  const speakerName = said?.kind === 'line' ? said.speaker : null
  const text = displayMacros(player.revealedText, { char: speakerName ?? cast.fallback.name, user: cast.user.name })

  return (
    <div
      className={cx(
        'vn-view relative flex h-full min-w-0 flex-1 flex-col overflow-hidden select-none',
        cinema && 'vn-cinema',
      )}
      style={{ ['--vn-ms' as string]: `${transitionMs}ms` }}
    >
      <Slot
        name="vn.layer"
        props={{
          chatId,
          stage: player.stage,
          beats: player.beats,
          beatIndex: player.beatIndex,
          playKey: player.playKey,
          play,
          skipping: player.skip || player.pinned,
        }}
      />
      {/* 点画面推进；隐藏界面时点一下恢复 */}
      <button
        type="button"
        aria-label={hidden ? t('显示界面') : t('下一句')}
        className="absolute inset-0 z-0 cursor-default"
        onClick={() => {
          setToolsOpen(false)
          if (hidden) setHidden(false)
          else if (!adjusting) player.advance()
        }}
      />

      {/* 立绘 */}
      <div className={cx('pointer-events-none absolute inset-x-0 top-0', mobile ? 'bottom-40' : 'bottom-44')}>
        <VnStage
          chatId={chatId}
          adjusting={adjusting}
          stage={player.stage}
          play={play}
          speakerKey={player.speakerKey}
          avatars={avatars}
          seed={current?.id ?? chatId}
          beatKey={player.beatKey ?? chatId}
          mobile={mobile}
        />
      </div>

      {/* 顶部：场景信息 + 操作 */}
      {!hidden && (
        <div className="relative z-10 flex items-start gap-2 p-3 pl-14 md:pl-3">
          {!cinema && (scene.place || scene.time) && (
            <div className="vn-chip max-w-[45%] truncate rounded-full px-3 py-1 text-xs">
              {[scene.place, scene.time].filter(Boolean).join(' · ')}
            </div>
          )}
          {inlineHud && play.interaction.hudPosition === 'top-left' && (
            <VnHud
              schema={stateSchema}
              vars={hudVars}
              position={play.interaction.hudPosition}
              floatDelta={play.interaction.floatDelta}
              mobile={mobile}
              onEdit={player.pinned || !play.interaction.varEdit ? undefined : editVar}
            />
          )}
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
            {inlineHud && play.interaction.hudPosition !== 'top-left' && (
              <VnHud
                schema={stateSchema}
                vars={hudVars}
                position={play.interaction.hudPosition}
                floatDelta={play.interaction.floatDelta}
                mobile={mobile}
                onEdit={player.pinned || !play.interaction.varEdit ? undefined : editVar}
              />
            )}
            <VnButton
              label={showTools ? t('收起操作栏') : t('展开操作栏')}
              active={showTools}
              onClick={() => setToolsOpen(!showTools)}
            >
              {showTools ? <ChevronRightIcon /> : <ChevronLeftIcon />}
              {/* 收起时用小圆点提示：有新图片、正在自动播放或快进 */}
              {!showTools && (images.pending || images.unread || player.auto || player.skip) && (
                <span
                  aria-hidden="true"
                  className={cx(
                    'absolute top-1 right-1 size-2 rounded-full',
                    images.pending ? 'animate-pulse bg-violet-400' : 'bg-white',
                  )}
                />
              )}
            </VnButton>
            {showTools && (
              <div className="vn-tools-in flex min-w-0 flex-wrap items-center justify-end gap-1">
                {images.latest && (
                  <VnButton
                    label={images.open ? t('收起图片') : t('图片')}
                    active={images.open}
                    onClick={images.toggle}
                  >
                    <ImageIcon />
                    {(images.pending || images.unread) && (
                      <span
                        aria-hidden="true"
                        className={cx(
                          'absolute top-1 right-1 size-2 rounded-full',
                          images.pending ? 'animate-pulse bg-violet-400' : 'bg-white',
                        )}
                      />
                    )}
                  </VnButton>
                )}
                {play.stage.draggable && (
                  <VnButton
                    label={adjusting ? t('完成调整') : t('调整立绘（拖动位置、滚轮缩放）')}
                    active={adjusting}
                    onClick={() => setAdjusting(!adjusting)}
                  >
                    <MoveIcon />
                  </VnButton>
                )}
                <VnButton label={t('存档 / 读档')} active={saves} onClick={() => setSaves(!saves)}>
                  <BookmarkIcon />
                </VnButton>
                <VnButton label={t('回想')} active={backlog} onClick={() => setBacklog(!backlog)}>
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
                <VnButton label={t('隐藏界面（点画面恢复）')} onClick={() => setHidden(true)}>
                  <EyeOffIcon />
                </VnButton>
              </div>
            )}
            <VnButton label={t('回到聊天视图')} onClick={() => setMode(chatId, 'chat')}>
              <XIcon />
            </VnButton>
          </div>
        </div>
      )}

      {/* 状态面板：手机 / 「顶部一行」是画面上方的一行摘要；宽屏的在顶部操作栏里 */}
      {!hidden && !cinema && showHud && hudBar && !saves && !backlog && (
        <VnHud
          schema={stateSchema}
          vars={hudVars}
          position={play.interaction.hudPosition}
          floatDelta={play.interaction.floatDelta}
          mobile={mobile}
          onEdit={player.pinned || !play.interaction.varEdit ? undefined : editVar}
        />
      )}

      {/* 战斗：顶部居中的先攻条 */}
      {!hidden && !cinema && combat && trpg.initiativeBar && (
        <div className="pointer-events-none absolute inset-x-0 top-14 z-[7] flex justify-center px-4">
          <InitiativeBar combat={combat} vars={hudVars} avatarOf={avatarOf} playerName={cast.user.name} />
        </div>
      )}

      {/* 模型刚调用的掷骰 / 检定：在画面上方弹一张卡片，演完淡出 */}
      {!hidden && lastRoll && rollFresh && !pickChoice.pending && (
        <div className="pointer-events-none absolute inset-x-0 top-1/4 z-30 flex justify-center px-4">
          {lastRoll.meta.check ? (
            <CheckCard
              result={lastRoll.meta.check}
              animate={trpg.diceAnimation}
              ms={trpg.diceMs}
              showDc={trpg.showDc}
            />
          ) : lastRoll.meta.dice ? (
            <DiceCard result={lastRoll.meta.dice} animate={trpg.diceAnimation} ms={trpg.diceMs} />
          ) : null}
        </div>
      )}

      {/* CG：盖住立绘和背景，点画面继续（推进按钮在最底层，CG 层不拦点击） */}
      {player.cg && <VnCg cg={player.cg} />}

      {/* 电影模式的上下黑边 */}
      {cinema && (
        <>
          <div aria-hidden="true" className="vn-letterbox pointer-events-none absolute inset-x-0 top-0 z-[5]" />
          <div aria-hidden="true" className="vn-letterbox pointer-events-none absolute inset-x-0 bottom-0 z-[5]" />
        </>
      )}

      {/* 生成的图片：右上角浮动卡片，不挡对话框 */}
      {!hidden && images.open && images.latest && (
        <VnImageCard
          chatId={chatId}
          message={images.latest}
          mobile={mobile}
          // HUD 在右上角时，图片卡片挪到左边，两个不叠在一起
          side={showHud && !hudBar && play.interaction.hudPosition === 'top-right' ? 'left' : 'right'}
          onClose={images.close}
        />
      )}

      {/* NVL：全屏文本 */}
      {!hidden && nvl && beat && (
        <div className="pointer-events-none relative z-10 mx-auto mt-2 flex w-full max-w-3xl flex-1 items-center px-4 pb-48">
          <div className="vn-nvl w-full rounded-2xl px-6 py-5 leading-loose" style={{ fontSize: play.dialog.fontSize }}>
            <p className="whitespace-pre-wrap">{text}</p>
            {player.complete && !player.ended && <Caret />}
          </div>
        </div>
      )}

      <div className="flex-1" />

      {/* 选项：画面中央偏下，像 Galgame 的选择肢 */}
      {!hidden && !adjusting && choices && choices.length > 0 && player.complete && play.interaction.choices && (
        <div
          className={cx(
            'relative z-10 mx-auto mb-3 flex w-full gap-2 px-4',
            choiceRow ? 'max-w-3xl flex-wrap justify-center' : 'max-w-xl flex-col',
          )}
        >
          {choices.map((option, i) => (
            <button
              // 选项在消息定稿后不变，下标做 key 是安全的
              key={i}
              type="button"
              disabled={busy || pickChoice.busy}
              onClick={() => void pickChoice.pick(option).catch((e: unknown) => toast.error(errorMessage(e)))}
              className={cx(
                'vn-choice flex min-h-11 items-center gap-3 rounded-xl px-4 py-2 text-left text-sm disabled:opacity-50',
                choiceRow ? 'min-w-32 justify-center' : 'w-full',
              )}
            >
              <span className="min-w-0 flex-1">{option.text}</span>
              {option.check && (
                <span className="shrink-0 rounded-md bg-amber-400/20 px-1.5 py-0.5 text-[11px] font-medium text-amber-200">
                  {checkSkillLabel(option.check.skill)}
                  {trpg.showDc && ` DC${option.check.dc}`}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* 选项检定的掷骰演出：盖在画面中央，演完自动发送 */}
      {pickChoice.pending && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
          <CheckCard result={pickChoice.pending} animate={trpg.diceAnimation} ms={trpg.diceMs} showDc={trpg.showDc} />
        </div>
      )}

      {/* ADV：底部对话框 */}
      {!hidden && !nvl && cinema && !player.cg && (
        <div className="pointer-events-none relative z-10 mx-auto w-full max-w-3xl px-6 pb-[calc(var(--vn-letterbox)*0.5)] text-center">
          {speakerName && play.dialog.nameplate && (
            <div className="vn-subtitle-name mb-1 text-sm font-semibold">{speakerName}</div>
          )}
          <p className="vn-subtitle leading-relaxed whitespace-pre-wrap" style={{ fontSize: play.dialog.fontSize }}>
            {said ? text : player.streaming ? '……' : ''}
          </p>
        </div>
      )}

      {!hidden && !nvl && !cinema && !player.cg && (
        <div className="pointer-events-none relative z-10 mx-auto w-full max-w-4xl px-3 pb-2 md:px-6">
          <div
            className="vn-box relative min-h-32 rounded-2xl px-5 pt-6 pb-8 md:px-7"
            style={{ ['--vn-box-alpha' as string]: `${play.dialog.boxOpacity}%`, fontSize: play.dialog.fontSize }}
          >
            {speakerName && play.dialog.nameplate && (
              <div className="vn-nameplate absolute -top-4 left-5 rounded-lg px-3 py-1 text-sm font-semibold">
                {speakerName}
              </div>
            )}
            {said ? (
              <p className="leading-relaxed whitespace-pre-wrap">{text}</p>
            ) : (
              <p className="text-sm opacity-60">
                {player.streaming
                  ? '……'
                  : current
                    ? t('这条回复没有可演出的内容')
                    : t('还没有角色回复，在下面说点什么吧')}
              </p>
            )}
            {showSwipes && current && (
              <div className="pointer-events-auto absolute bottom-1 left-3 flex items-center text-[11px] md:left-5">
                <SwipeButton
                  label={current.parentId === null ? t('上一个开场白') : t('上一个回复')}
                  disabled={current.swipeIndex <= 1}
                  onClick={() => void swipe(-1)}
                >
                  <ChevronLeftIcon />
                </SwipeButton>
                <span className="min-w-9 text-center tabular-nums opacity-60">
                  {current.swipeIndex} / {current.swipeCount}
                </span>
                <SwipeButton
                  label={
                    current.swipeIndex < current.swipeCount
                      ? current.parentId === null
                        ? t('下一个开场白')
                        : t('下一个回复')
                      : t('生成新回复')
                  }
                  disabled={current.swipeIndex === current.swipeCount && !canRegenerate}
                  onClick={() => void swipe(1)}
                >
                  <ChevronRightIcon />
                </SwipeButton>
                {canRegenerate && (
                  <SwipeButton label={t('重新生成（保留现有回复，再写一个）')} onClick={regenerate}>
                    <RefreshIcon />
                  </SwipeButton>
                )}
              </div>
            )}
            <div className="absolute right-4 bottom-2 flex items-center gap-2 text-[11px] opacity-60">
              {player.streaming && <span>{t('生成中…')}</span>}
              {player.canBack && (
                <button
                  type="button"
                  title={t('回退（看上一句，或上一条回复）')}
                  aria-label={t('回退')}
                  onClick={player.back}
                  className="pointer-events-auto -my-1 flex size-6 items-center justify-center rounded-full hover:bg-white/15 [&_svg]:size-3.5"
                >
                  <ChevronLeftIcon />
                </button>
              )}
              {player.shownCount > 0 && (
                <span className="tabular-nums">
                  {player.index + 1} / {player.shownCount}
                </span>
              )}
              {player.complete && !player.ended && <Caret />}
            </div>
          </div>
        </div>
      )}

      {!hidden && adjusting && <AdjustBar chatId={chatId} onDone={() => setAdjusting(false)} />}

      {/* 演完了（或在等生成）：输入框；重演旧消息时给一个回到最新的入口 */}
      {!hidden && !adjusting && (
        <div className="relative z-10">
          {player.pinned ? (
            <div className="mx-auto mb-3 flex w-full max-w-4xl justify-center px-3">
              <button
                type="button"
                className="vn-chip rounded-full px-4 py-1.5 text-sm"
                onClick={() => player.followLatest()}
              >
                {t('正在重演旧的回复，回到最新')}
              </button>
            </div>
          ) : ended || busy ? (
            (!choices?.length || play.interaction.inputWithChoices) && (
              <div className="vn-composer">
                <Composer chatId={chatId} generating={busy} group={group} lastMessage={messages.at(-1) ?? null} />
              </div>
            )
          ) : (
            <div className="mx-auto mb-3 flex w-full max-w-4xl justify-end gap-2 px-3 md:px-6">
              <button
                type="button"
                className="vn-chip flex items-center gap-1 rounded-full px-3 py-1 text-xs"
                onClick={() => player.jumpToEnd()}
              >
                {t('跳到这条的结尾')}
                <ChevronRightIcon className="size-3.5" />
              </button>
            </div>
          )}
        </div>
      )}

      {saves && (
        <VnSaves
          chatId={chatId}
          play={play}
          // 重演旧回复时存的是正在看的那条；否则存当前分支的最新位置
          currentId={player.pinned ? (current?.id ?? null) : null}
          onLoaded={() => {
            setSaves(false)
            player.followLatest()
          }}
          onClose={() => setSaves(false)}
        />
      )}

      {backlog && (
        <Backlog
          messages={messages}
          play={play}
          cast={cast}
          currentId={current?.id ?? null}
          onReplay={(id) => {
            player.replay(id)
            setBacklog(false)
          }}
          onClose={() => setBacklog(false)}
        />
      )}
    </div>
  )
}

/** 调整立绘时代替输入框的操作条：说明、整体大小、全部恢复、完成 */
function AdjustBar({ chatId, onDone }: { chatId: string; onDone: () => void }) {
  const all = useSpriteLayout((s) => s.vn[chatId]?.all ?? 1)
  const setAll = useSpriteLayout((s) => s.setAll)
  const resetChat = useSpriteLayout((s) => s.resetChat)
  return (
    <div className="relative z-20 mx-auto mb-3 w-full max-w-4xl px-3 md:px-6">
      <div className="vn-box flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl px-4 py-3 text-sm">
        <span className="min-w-0 flex-1 text-xs opacity-75">
          {t('拖动立绘调整位置，滚轮或双指捏合缩放。只保存在这台设备上，按会话记住。')}
        </span>
        <label className="flex items-center gap-2 text-xs">
          {t('整体大小')}
          <input
            type="range"
            min={30}
            max={300}
            step={5}
            value={Math.round(all * 100)}
            onChange={(e) => setAll(chatId, Number(e.target.value) / 100)}
            className="w-28 accent-violet-400"
          />
          <span className="w-10 tabular-nums">{Math.round(all * 100)}%</span>
        </label>
        <button
          type="button"
          className="vn-chip rounded-full px-3 py-1 text-xs"
          onClick={() => {
            if (confirm(t('恢复这个会话里所有立绘的默认位置和大小？'))) resetChat(chatId)
          }}
        >
          {t('全部恢复')}
        </button>
        <button type="button" className="vn-chip vn-chip-active rounded-full px-4 py-1 text-xs" onClick={onDone}>
          {t('完成')}
        </button>
      </div>
    </div>
  )
}

/** 对话框里切换备选的小按钮 */
function SwipeButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-full opacity-60 hover:bg-white/10 hover:opacity-100 disabled:opacity-25 disabled:hover:bg-transparent [&_svg]:size-3.5"
    >
      {children}
    </button>
  )
}

/** 「这一句显示完了，点一下继续」的小三角 */
function Caret() {
  return <span className="vn-caret inline-block">▼</span>
}

function VnButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        'vn-chip relative flex size-9 items-center justify-center rounded-full transition-colors [&_svg]:size-4',
        active && 'vn-chip-active',
      )}
    >
      {children}
    </button>
  )
}

/** 回想：最近的对话记录（去掉指令后的文字），角色回复可以「从这里重演」 */
function Backlog({
  messages,
  play,
  cast,
  currentId,
  onReplay,
  onClose,
}: {
  messages: MessageDTO[]
  play: PlayPresetData
  cast: ChatCast
  currentId: string | null
  onReplay: (id: string) => void
  onClose: () => void
}) {
  const knownNames = cast.stage?.knownNames ?? []
  const list = messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-60)
  // 打开时停在最新的记录（像 VN 的回想一样从下往上翻）
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [])
  return (
    <div className="absolute inset-0 z-30 flex justify-end">
      {/* 点抽屉外面的暗处关闭 */}
      <button type="button" aria-label={t('关闭回想')} className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div role="dialog" aria-label={t('回想')} className="vn-backlog relative flex h-full w-full max-w-xl flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-white/10 px-4">
          <h2 className="flex-1 font-semibold">{t('回想')}</h2>
          <button
            type="button"
            aria-label={t('关闭回想')}
            className="vn-chip flex size-8 items-center justify-center rounded-full"
            onClick={onClose}
          >
            <XIcon className="size-4" />
          </button>
        </div>
        <div ref={scroller} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 select-text">
          {list.map((m) => {
            const user = m.role === 'user'
            const name = user ? cast.user.name : (m.speakerId && cast.speakers[m.speakerId]?.name) || m.meta.name || ''
            const body = user
              ? m.content
              : toDisplayText(m.content, {
                  knownNames,
                  narratorNames: play.trpg.gmName ? [play.trpg.gmName] : [],
                  speaker: 'plain',
                })
            return (
              <div key={m.id} className={cx('rounded-xl p-3', m.id === currentId ? 'bg-white/15' : 'bg-white/5')}>
                <div className="mb-1 flex items-center gap-2 text-xs opacity-70">
                  <span className="font-semibold">{name}</span>
                  {!user && (
                    <button
                      type="button"
                      className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-white/10"
                      onClick={() => onReplay(m.id)}
                    >
                      <RefreshIcon className="size-3" />
                      {t('从这里重演')}
                    </button>
                  )}
                </div>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{body || t('（图片或空内容）')}</p>
              </div>
            )
          })}
          {list.length === 0 && <p className="text-sm opacity-60">{t('还没有对话。')}</p>}
        </div>
      </div>
    </div>
  )
}

/** CG 拍：全屏铺满显示生成的插图（和背景一样按屏幕裁切，不留黑边）；还在画时显示占位 */
function VnCg({ cg }: { cg: NonNullable<ReturnType<typeof useVnPlayer>['cg']> }) {
  return (
    <div className="vn-cg pointer-events-none absolute inset-0 z-[6] flex items-center justify-center bg-black">
      {cg.url ? (
        <img key={cg.url} src={cg.url} alt={cg.prompt} className="vn-cg-image size-full object-cover" />
      ) : (
        <div className="flex flex-col items-center gap-3 text-sm text-white/70">
          <span className="size-8 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
          {t('正在绘制 CG…')}
        </div>
      )}
    </div>
  )
}
