import type { MattingPart } from '@nobot/shared'
import { useId } from 'react'
import { useInstallMatting, useMattingStatus, useRemoveMatting } from '../../../api/matting'
import { DenseRow } from '../../../components/form'
import { Button } from '../../../components/ui'
import { t } from '../../../i18n'
import { errorMessage, toast } from '../../../stores/toast'

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`

/** 一个部件（运行时或模型）的状态文字 */
function describe(part: MattingPart) {
  if (part.state === 'ready') return t('已就绪')
  if (part.state === 'error') return part.error || t('失败')
  if (part.state === 'installing') return part.total ? `${mb(part.received ?? 0)} / ${mb(part.total)}` : t('安装中…')
  return t('未下载')
}

/**
 * 设置里「本地模型抠图」的下载控件：显示运行时和模型的状态，下载、重试、删除。
 * 选了 model 模式但还没下载完时，生成立绘会自动退回算法抠图，所以这里只提示、不拦。
 */
export function MattingModelField({ hint, disabled }: { hint?: string | undefined; disabled: boolean }) {
  const id = useId()
  const status = useMattingStatus(true)
  const install = useInstallMatting()
  const remove = useRemoveMatting()
  const data = status.data
  const parts = data ? [data.runtime, data.model] : []
  const installing = parts.some((p) => p.state === 'installing')
  const ready = parts.length > 0 && parts.every((p) => p.state === 'ready')
  const failed = parts.some((p) => p.state === 'error')
  const model = data?.model
  const percent =
    model?.state === 'installing' && model.total ? Math.min(100, ((model.received ?? 0) / model.total) * 100) : null

  return (
    <DenseRow id={id} label={t('抠图模型')} hint={hint} disabled={disabled} wide>
      <div id={id} className="min-w-0 flex-1 space-y-1.5">
        {status.isLoading && <p className="text-[13px] text-zinc-500">{t('加载中…')}</p>}
        {status.error && <p className="text-[13px] text-red-600">{errorMessage(status.error)}</p>}
        {data && (
          <>
            <div className="flex min-h-9 items-center gap-3">
              <dl className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-0.5 text-[13px]">
                <div className="flex gap-1.5">
                  <dt className="text-zinc-500">{t('运行时')}</dt>
                  <dd className={data.runtime.state === 'error' ? 'text-red-600' : ''}>{describe(data.runtime)}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="text-zinc-500">{t('模型')}</dt>
                  <dd className={data.model.state === 'error' ? 'text-red-600' : ''}>{describe(data.model)}</dd>
                </div>
              </dl>
              <div className="flex shrink-0 gap-2">
                {ready ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled || remove.isPending}
                    onClick={() => {
                      if (confirm(t('删除已下载的抠图模型和运行时？')))
                        remove.mutate(undefined, { onError: (e) => toast.error(errorMessage(e)) })
                    }}
                  >
                    {t('删除模型')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={disabled || installing || install.isPending}
                    onClick={() => install.mutate(undefined, { onError: (e) => toast.error(errorMessage(e)) })}
                  >
                    {installing ? t('下载中…') : failed ? t('重试') : t('下载（约 170 MB）')}
                  </Button>
                )}
              </div>
            </div>
            {percent !== null && (
              <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                <div
                  className="h-full rounded-full bg-zinc-900 transition-[width] dark:bg-zinc-100"
                  style={{ width: `${percent}%` }}
                />
              </div>
            )}
            {!ready && !installing && (
              <p className="text-xs text-zinc-500">{t('下载完成前，生成立绘会先用算法抠图。')}</p>
            )}
          </>
        )}
      </div>
    </DenseRow>
  )
}
