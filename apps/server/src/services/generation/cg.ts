import type { Beat, MessageMeta } from '@nobot/shared'

/** 正文编辑可能移动拍点。同一提示词出现多次时，按出现顺序保留原来的图片和任务。 */
export function reconcileCg(beats: Beat[], entries: NonNullable<MessageMeta['cg']>) {
  const byPrompt = new Map<string, NonNullable<MessageMeta['cg']>>()
  for (const entry of entries.toReversed()) {
    const matching = byPrompt.get(entry.prompt)
    if (matching) matching.push(entry)
    else byPrompt.set(entry.prompt, [entry])
  }
  return beats.flatMap((beat, index) => {
    if (beat.kind !== 'cg') return []
    const entry = byPrompt.get(beat.prompt)?.pop()
    return entry ? [{ ...entry, beat: index }] : []
  })
}
