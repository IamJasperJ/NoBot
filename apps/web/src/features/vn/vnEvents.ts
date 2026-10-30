import type { Beat } from '@nobot/shared'
import { useEffect, useRef } from 'react'
import { emitClientEvent, hasListener } from '../../extensions/runtime'
import type { VnDirective } from '../../extensions/types'

/** 一拍里的舞台指令：舞台操作拍是它的全部操作；选项、CG 拍各算一条；台词和旁白不算 */
export function directivesOf(beat: Beat): VnDirective[] {
  if (beat.kind === 'stage') return beat.ops
  if (beat.kind === 'choices') return [{ op: 'choices', options: beat.options }]
  if (beat.kind === 'cg') return [{ op: 'cg', prompt: beat.prompt }]
  return []
}

/**
 * 从上一次的位置走到 beatIndex 时「新演到」的拍序号区间 [from, to]（含两端）。
 * - 同一条消息往前走：上一次之后到这一拍（舞台操作拍不停留，夹在中间的也算演到了）
 * - 换了一条消息且从第一个停留拍开始：从头算，开头的舞台操作也算
 * - 回退、打开旧会话直接停在末拍：只算当前这一拍，不把整条消息的指令重放一遍
 */
export function passedRange(
  prev: { playKey: string; beatIndex: number } | null,
  playKey: string,
  beatIndex: number,
  firstShown: number | undefined,
): [number, number] {
  if (prev?.playKey === playKey)
    return beatIndex > prev.beatIndex ? [prev.beatIndex + 1, beatIndex] : [beatIndex, beatIndex]
  return beatIndex === firstShown ? [0, beatIndex] : [beatIndex, beatIndex]
}

/**
 * 把 VN 的演出进度发成前端事件 vn:line / vn:directive。
 * 没有扩展订阅时什么都不做；同一位置只发一次（重渲染、打字机推进不会重复发）
 */
export function useVnEvents({
  chatId,
  messageId,
  playKey,
  beats,
  beatIndex,
  firstShown,
  skipping,
  format,
}: {
  chatId: string
  messageId: string | undefined
  playKey: string | null
  beats: Beat[]
  beatIndex: number | undefined
  firstShown: number | undefined
  skipping: boolean
  /** 台词文字的显示处理（替换 {{char}} / {{user}}），和对话框里显示的一致 */
  format: (text: string, speaker: string | null) => string
}) {
  const last = useRef<{ playKey: string; beatIndex: number } | null>(null)
  // beats 在流式时每个字都会变；只在位置变化时发，其余参数读最新值即可
  useEffect(() => {
    if (!playKey || !messageId || beatIndex === undefined) return
    const prev = last.current
    if (prev?.playKey === playKey && prev.beatIndex === beatIndex) return
    last.current = { playKey, beatIndex }
    const [from, to] = passedRange(prev, playKey, beatIndex, firstShown)
    if (hasListener('vn:directive')) {
      for (let i = from; i <= to; i++) {
        const beat = beats[i]
        if (!beat) continue
        for (const directive of directivesOf(beat))
          emitClientEvent({ type: 'vn:directive', chatId, messageId, beatIndex: i, directive, skipping })
      }
    }
    const beat = beats[beatIndex]
    if ((beat?.kind === 'line' || beat?.kind === 'narration') && hasListener('vn:line')) {
      const speaker = beat.kind === 'line' ? beat.speaker : null
      emitClientEvent({
        type: 'vn:line',
        chatId,
        messageId,
        beatIndex,
        speaker,
        text: format(beat.text, speaker),
        skipping,
      })
    }
  }, [playKey, beatIndex])
}
