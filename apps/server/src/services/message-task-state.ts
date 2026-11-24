import type { MessageMeta } from '@nobot/shared'

/** 图片、CG 和立绘等待状态属于原进程中的任务，脱离任务后只保留已产生的内容。 */
export function interruptMessageTasks(meta: MessageMeta, imageError: () => string): MessageMeta {
  const image = meta.imageGen?.status === 'pending' ? meta.imageGen : undefined
  const cg = Array.isArray(meta.cg) && meta.cg.some((entry) => entry?.status === 'pending') ? meta.cg : undefined
  const spritesPending = meta.spriteGeneration === 'pending'
  const stage = meta.stage?.classify === 'pending' ? meta.stage : undefined
  if (!image && !cg && !spritesPending && !stage) return meta

  const updated = { ...meta }
  if (image) {
    updated.imageGen = { ...image, status: 'error', stage: undefined, queuePosition: undefined, error: imageError() }
  }
  if (cg) {
    updated.cg = cg.map((entry) =>
      entry?.status === 'pending' ? { ...entry, status: 'error', taskId: undefined } : entry,
    )
  }
  if (spritesPending) delete updated.spriteGeneration
  if (stage) updated.stage = { ...stage, classify: undefined }
  return updated
}
