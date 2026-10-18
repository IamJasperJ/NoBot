import type { Beat, MessageMeta } from '@ai-parter/shared'

export type ShownBeat = Extract<Beat, { kind: 'line' | 'narration' | 'choices' | 'cg' }>

/** 返回原始拍序号，不能先过滤再编号：CG 元数据引用的是 stage.beats 下标。 */
export function shownBeatIndexes(beats: Beat[], cg: MessageMeta['cg'] = []): number[] {
  const stops = new Set(cg.filter((entry) => entry.status !== 'error').map((entry) => entry.beat))
  return beats.flatMap((beat, index) =>
    beat.kind === 'line' ||
    beat.kind === 'narration' ||
    beat.kind === 'choices' ||
    (beat.kind === 'cg' && stops.has(index))
      ? [index]
      : [],
  )
}

export const beatText = (beat: ShownBeat | undefined) =>
  beat && (beat.kind === 'line' || beat.kind === 'narration') ? beat.text : ''

export function currentCg(beats: Beat[], index: number | undefined, meta?: MessageMeta) {
  const beat = index === undefined ? undefined : beats[index]
  const entry = meta?.cg?.find((entry) => entry.beat === index && entry.status !== 'error')
  if (beat?.kind !== 'cg' || !entry) return undefined
  return {
    status: entry.status,
    url: meta?.images?.find((image) => image.id === entry.attachmentId)?.url,
    prompt: beat.prompt,
  }
}

/** CG 完成后留双倍阅读时间；待生成时不启动自动推进定时器。 */
export function autoAdvanceDelay(seconds: number, length: number, cg?: ReturnType<typeof currentCg>) {
  if (cg?.status === 'pending') return null
  return cg ? seconds * 2000 : seconds * 1000 + Math.min(length * 30, 3000)
}
