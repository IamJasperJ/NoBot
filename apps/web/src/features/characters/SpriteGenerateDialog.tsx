import { EXPRESSIONS } from '@ai-parter/shared'
import { useState } from 'react'
import { useGenerateSprites, useSpriteJob } from '../../api/queries'
import { TextAreaField } from '../../components/form'
import { WandIcon } from '../../components/icons'
import { Button, cx, Dialog } from '../../components/ui'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'

/** 常用的几个表情，一键勾选 */
const COMMON = ['neutral', 'joy', 'sadness', 'anger', 'surprise', 'embarrassment', 'love', 'fear']

/**
 * 「AI 生成立绘」对话框：选表情（默认常用 8 个）、可选外貌提示词，提交后在后台生成。
 * 生成进度显示在立绘区上方（SpriteJobBar），关掉对话框也会继续。
 */
export function SpriteGenerateDialog({
  characterId,
  outfit,
  open,
  onClose,
  onStarted,
}: {
  characterId: string
  outfit: string
  open: boolean
  onClose: () => void
  onStarted: (jobId: string) => void
}) {
  const generate = useGenerateSprites(characterId)
  const [picked, setPicked] = useState<string[]>(COMMON)
  const [basePrompt, setBasePrompt] = useState('')
  const toggle = (e: string) => setPicked((list) => (list.includes(e) ? list.filter((x) => x !== e) : [...list, e]))

  return (
    <Dialog open={open} onClose={onClose} title={t('AI 生成立绘')}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (!picked.length) return
          generate.mutate(
            {
              outfit,
              expressions: picked,
              ...(basePrompt.trim() ? { basePrompt: basePrompt.trim() } : {}),
            },
            {
              onSuccess: ({ jobId }) => {
                onStarted(jobId)
                onClose()
              },
              onError: (error) => toast.error(errorMessage(error)),
            },
          )
        }}
      >
        <p className="text-xs leading-relaxed text-zinc-500">
          {t(
            '用图片生成扩展画一套立绘，存进「{outfit}」。先画 neutral 定下长相，其余表情用同一个种子，再自动去掉白底。效果取决于你的生图模型，画完可以逐张删掉不满意的。',
            { outfit: outfit || t('默认服装') },
          )}
        </p>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-[13px] font-medium">
              {t('表情（已选 {count} 个）', { count: picked.length })}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setPicked(COMMON)}>
              {t('常用')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPicked([...EXPRESSIONS])}>
              {t('全部 28 个')}
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {EXPRESSIONS.map((e) => (
              <button
                key={e}
                type="button"
                aria-pressed={picked.includes(e)}
                onClick={() => toggle(e)}
                className={cx(
                  'h-7 rounded-md border px-2 text-xs transition-colors',
                  picked.includes(e)
                    ? 'border-violet-300 bg-violet-50 font-medium text-violet-700 dark:border-violet-800 dark:bg-violet-950/60 dark:text-violet-300'
                    : 'border-zinc-200 text-zinc-500 hover:border-zinc-300 dark:border-zinc-700',
                )}
              >
                {e}
              </button>
            ))}
          </div>
        </div>
        <TextAreaField
          label={t('外貌描述（可选）')}
          hint={t('英文标签或描述，例如 1girl, long silver hair, blue eyes, maid outfit。留空时从角色卡里提取')}
          rows={3}
          value={basePrompt}
          onChange={setBasePrompt}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button type="submit" variant="primary" disabled={!picked.length || generate.isPending}>
            <WandIcon />
            {generate.isPending ? t('提交中…') : t('开始生成')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

/** 生成进度条：放在立绘区上方，完成后显示结果，点「知道了」收起 */
export function SpriteJobBar({
  characterId,
  jobId,
  onDismiss,
}: {
  characterId: string
  jobId: string
  onDismiss: () => void
}) {
  const job = useSpriteJob(characterId, jobId)
  const data = job.data
  if (!data) return null
  const finished = data.status === 'done' || data.status === 'error'
  const percent = data.total ? Math.round(((data.done + data.failed) / data.total) * 100) : 0
  return (
    <div className="space-y-1.5 rounded-lg bg-violet-50 px-3 py-2 text-[13px] text-violet-800 dark:bg-violet-950/50 dark:text-violet-200">
      <div className="flex items-center gap-2">
        <span className="flex-1">
          {finished
            ? data.failed
              ? t('生成完成：{done} 张成功，{failed} 张失败（详情见日志）', { done: data.done, failed: data.failed })
              : t('生成完成：{done} 张立绘', { done: data.done })
            : t('正在生成立绘… {done} / {total}', { done: data.done + data.failed, total: data.total })}
        </span>
        {finished && (
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            {t('知道了')}
          </Button>
        )}
      </div>
      {!finished && (
        <div className="h-1 overflow-hidden rounded-full bg-violet-200 dark:bg-violet-900">
          <div className="h-full rounded-full bg-violet-500 transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  )
}
