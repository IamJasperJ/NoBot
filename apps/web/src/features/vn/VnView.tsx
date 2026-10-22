import type { ChoiceOption, GroupDTO, MessageDTO, PlayPresetData, StateSchema } from '@nobot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api/client'
import { refreshChatState } from '../../api/queries'
import { useFreshDice, usePickChoice, useTrpgSettings } from '../../api/trpg'
import { ChevronRightIcon } from '../../components/icons'
import { cx } from '../../components/ui'
import { Slot } from '../../extensions/Slot'
import { useMobile } from '../../hooks/useMobile'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'
import { useCinema } from '../../stores/vn'
import { Composer } from '../chat/Composer'
import { displayMacros } from '../chat/format'
import type { ChatCast } from '../chat/MessageItem'
import { CheckCard, DiceCard } from '../trpg/DiceCard'
import { InitiativeBar } from '../trpg/InitiativeBar'
import { useCgRefresh } from './useCgRefresh'
import { useVnPlayer } from './useVnPlayer'
import { VnBacklog } from './VnBacklog'
import { VnDialogBox } from './VnDialogBox'
import { VnHud } from './VnHud'
import { useVnImages, VnImageCard } from './VnImages'
import { AdjustBar, Caret, VnCg, VnChoices } from './VnParts'
import { VnSaves } from './VnSaves'
import { VnStage } from './VnStage'
import { VnToolbar } from './VnToolbar'

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
  // 这条回复的 CG 还在画：定时刷新会话，画好后自动显示
  useCgRefresh(chatId, current)
  // 转场时长给 CSS 用（立绘进出场、CG 淡入）；「无」就是 0
  const transitionMs = play.stage.transition === 'none' ? 0 : play.stage.transitionMs
  // 调整立绘：拖动位置、缩放（玩法预设「允许拖动立绘」开着时才有这个入口）
  const [adjusting, setAdjusting] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)

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
  const hud = (
    <VnHud
      schema={stateSchema}
      vars={hudVars}
      position={play.interaction.hudPosition}
      floatDelta={play.interaction.floatDelta}
      mobile={mobile}
      onEdit={player.pinned || !play.interaction.varEdit ? undefined : editVar}
    />
  )

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
  // 选项排列：自动 = 选项少且都短时横排，否则竖排
  const choiceRow =
    play.interaction.choiceLayout === 'row' ||
    (play.interaction.choiceLayout === 'auto' &&
      !!choices &&
      choices.length <= 3 &&
      choices.every((c) => Array.from(c.text).length <= 12))

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
          skipping: player.skip,
          streaming: player.streaming,
          replayToken: player.replayToken,
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
        <VnToolbar
          chatId={chatId}
          play={play}
          player={player}
          images={images}
          scene={player.stage.scene}
          cinema={cinema}
          hudLeft={inlineHud && play.interaction.hudPosition === 'top-left' ? hud : undefined}
          hudRight={inlineHud && play.interaction.hudPosition !== 'top-left' ? hud : undefined}
          tools={{ on: toolsOpen, set: setToolsOpen }}
          adjusting={{ on: adjusting, set: setAdjusting }}
          saves={{ on: saves, set: setSaves }}
          backlog={{ on: backlog, set: setBacklog }}
          onHide={() => setHidden(true)}
        />
      )}

      {/* 状态面板：手机 / 「顶部一行」是画面上方的一行摘要；宽屏的在顶部操作栏里 */}
      {!hidden && !cinema && showHud && hudBar && !saves && !backlog && hud}

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

      {!hidden && !adjusting && choices && choices.length > 0 && player.complete && play.interaction.choices && (
        <VnChoices
          options={choices}
          row={choiceRow}
          disabled={busy || pickChoice.busy}
          showDc={trpg.showDc}
          onPick={(option) => void pickChoice.pick(option).catch((e: unknown) => toast.error(errorMessage(e)))}
        />
      )}

      {/* 选项检定的掷骰演出：盖在画面中央，演完自动发送 */}
      {pickChoice.pending && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
          <CheckCard result={pickChoice.pending} animate={trpg.diceAnimation} ms={trpg.diceMs} showDc={trpg.showDc} />
        </div>
      )}

      {/* ADV：底部对话框（电影模式下是字幕） */}
      {!hidden && !nvl && !player.cg && (
        <VnDialogBox
          chatId={chatId}
          messages={messages}
          play={play}
          player={player}
          busy={busy}
          cinema={cinema}
          speakerName={speakerName}
          text={text}
        />
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
        <VnBacklog
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
