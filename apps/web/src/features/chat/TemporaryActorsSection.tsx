import type { TemporaryActorDTO } from '@nobot/shared'
import { useRef, useState } from 'react'
import {
  useRegenerateTemporaryActor,
  useRemoveTemporaryActor,
  useTemporaryActors,
  useUploadTemporaryActor,
} from '../../api/temporaryActors'
import { Section, SwitchField, TextAreaField } from '../../components/form'
import { RefreshIcon, TrashIcon, UploadIcon, UserIcon, WandIcon } from '../../components/icons'
import { Button, cx, Dialog } from '../../components/ui'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'

/** 透明立绘下面垫一层浅色棋盘格，方便看清去背景的效果 */
const checker =
  'bg-[length:16px_16px] bg-[linear-gradient(45deg,#0000000d_25%,transparent_25%,transparent_75%,#0000000d_75%),linear-gradient(45deg,#0000000d_25%,transparent_25%,transparent_75%,#0000000d_75%)] bg-[position:0_0,8px_8px] dark:bg-[linear-gradient(45deg,#ffffff0f_25%,transparent_25%,transparent_75%,#ffffff0f_75%),linear-gradient(45deg,#ffffff0f_25%,transparent_25%,transparent_75%,#ffffff0f_75%)]'

const statusText = (actor: TemporaryActorDTO) => {
  switch (actor.status) {
    case 'pending':
      return t('生成中…')
    case 'error':
      return t('生成失败')
    case 'removed':
      return t('已删除立绘')
    default:
      return ''
  }
}

/**
 * 会话设置里的「临时立绘」：VN 里没有角色卡的 NPC 自动生成的立绘。
 * 可以查看大图、改外貌描述后重新生成、上传替换、删除。会话里没有临时立绘时整个分组不显示。
 */
export function TemporaryActorsSection({ chatId }: { chatId: string }) {
  const actors = useTemporaryActors(chatId)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const list = actors.data ?? []
  if (!list.length) return null
  const open = list.find((a) => a.key === openKey) ?? null
  return (
    <Section
      title={t('临时立绘')}
      description={t('VN 里没有角色卡的 NPC 自动生成的立绘，只在这个会话里使用')}
      defaultOpen={false}
    >
      <div className="grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-2">
        {list.map((actor) => (
          <button
            key={actor.key}
            type="button"
            onClick={() => setOpenKey(actor.key)}
            className="group flex min-w-0 flex-col overflow-hidden rounded-xl border border-zinc-200 text-left hover:border-violet-400 dark:border-zinc-800 dark:hover:border-violet-500"
          >
            <span className={cx('relative flex aspect-[3/4] items-end justify-center', checker)}>
              {actor.image ? (
                <img src={actor.image.url} alt="" className="size-full object-contain object-bottom" loading="lazy" />
              ) : (
                <UserIcon className="mb-[30%] size-10 text-zinc-300 dark:text-zinc-600" />
              )}
              {actor.status !== 'done' && (
                <span
                  className={cx(
                    'absolute inset-x-1 top-1 truncate rounded-md px-1.5 py-0.5 text-center text-[10px] font-medium',
                    actor.status === 'pending'
                      ? 'animate-pulse bg-violet-600/90 text-white'
                      : actor.status === 'error'
                        ? 'bg-red-500/90 text-white'
                        : 'bg-zinc-800/70 text-white',
                  )}
                >
                  {statusText(actor)}
                </span>
              )}
            </span>
            <span className="truncate border-t border-zinc-100 px-2 py-1 text-xs font-medium dark:border-zinc-800">
              {actor.name}
            </span>
          </button>
        ))}
      </div>
      {open && <ActorDialog key={open.key} chatId={chatId} actor={open} onClose={() => setOpenKey(null)} />}
    </Section>
  )
}

function ActorDialog({ chatId, actor, onClose }: { chatId: string; actor: TemporaryActorDTO; onClose: () => void }) {
  const [prompt, setPrompt] = useState(actor.prompt)
  const [removeBackground, setRemoveBackground] = useState(true)
  const file = useRef<HTMLInputElement>(null)
  const regenerate = useRegenerateTemporaryActor()
  const upload = useUploadTemporaryActor()
  const remove = useRemoveTemporaryActor()
  const pending = actor.status === 'pending'
  const busy = pending || regenerate.isPending || upload.isPending || remove.isPending
  const onError = (e: unknown) => toast.error(errorMessage(e))
  const run = (usePrompt: boolean) =>
    regenerate.mutate(
      { chatId, key: actor.key, prompt: usePrompt ? prompt.trim() || undefined : undefined },
      { onError, onSuccess: () => toast.info(t('已开始重新生成，完成后舞台会自动换上新立绘')) },
    )
  return (
    <Dialog open onClose={onClose} title={t('临时立绘：{name}', { name: actor.name })} className="sm:max-w-2xl">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)]">
        <div
          className={cx(
            'relative flex aspect-[3/4] items-end justify-center overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800',
            checker,
          )}
        >
          {actor.image ? (
            <img src={actor.image.url} alt={actor.name} className="size-full object-contain object-bottom" />
          ) : (
            <UserIcon className="mb-[30%] size-16 text-zinc-300 dark:text-zinc-600" />
          )}
          {pending && (
            <span className="absolute inset-0 flex items-center justify-center bg-white/60 text-sm font-medium text-violet-700 dark:bg-zinc-950/60 dark:text-violet-300">
              <span className="animate-pulse">{t('生成中…')}</span>
            </span>
          )}
        </div>
        <div className="min-w-0 space-y-3">
          {actor.status === 'error' && actor.error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
              {actor.error}
            </p>
          )}
          {actor.status === 'removed' && (
            <p className="rounded-lg bg-zinc-100 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              {t('立绘已删除，舞台上显示剪影，也不会再自动生成。')}
            </p>
          )}
          <TextAreaField
            label={t('外貌描述')}
            hint={t('英文图片描述，生成时会自动加上「全身、站姿、白底」等要求')}
            rows={6}
            value={prompt}
            placeholder={t('留空则根据对话重新推断外貌')}
            onChange={setPrompt}
          />
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" disabled={busy} onClick={() => run(true)}>
              <WandIcon />
              {t('按描述重新生成')}
            </Button>
            <Button
              size="sm"
              disabled={busy}
              title={t('忽略上面的描述，让模型根据当前对话重新推断外貌')}
              onClick={() => run(false)}
            >
              <RefreshIcon />
              {t('按对话重新推断')}
            </Button>
          </div>
          <div className="space-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
            <SwitchField label={t('上传时去除纯色背景')} checked={removeBackground} onChange={setRemoveBackground} />
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const picked = e.target.files?.[0]
                e.target.value = ''
                if (picked)
                  upload.mutate(
                    { chatId, key: actor.key, file: picked, removeBackground },
                    { onError, onSuccess: () => toast.info(t('已替换立绘')) },
                  )
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy} onClick={() => file.current?.click()}>
                <UploadIcon />
                {upload.isPending ? t('上传中…') : t('上传替换')}
              </Button>
              {actor.status !== 'removed' && (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(t('删除 {name} 的临时立绘？舞台上会改为剪影，也不再自动生成。', { name: actor.name })))
                      remove.mutate({ chatId, key: actor.key, purge: false }, { onError })
                  }}
                >
                  <TrashIcon />
                  {t('删除立绘')}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                title={t('移除这条记录；这个 NPC 下次上台时会重新自动生成')}
                onClick={() => {
                  if (confirm(t('移除 {name} 的记录？下次上台时会重新自动生成立绘。', { name: actor.name })))
                    remove.mutate({ chatId, key: actor.key, purge: true }, { onError, onSuccess: onClose })
                }}
              >
                {t('移除记录')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
