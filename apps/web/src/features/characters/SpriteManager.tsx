import { EXPRESSIONS, type SpriteDTO, type SpriteImportResult } from '@ai-parter/shared'
import { useQueryClient } from '@tanstack/react-query'
import { type DragEvent, useRef, useState } from 'react'
import { api } from '../../api/client'
import { keys, useSprites } from '../../api/queries'
import { Section } from '../../components/form'
import { PlusIcon, TrashIcon, UploadIcon } from '../../components/icons'
import { Button, badgeClass, cx, Dialog, IconButton } from '../../components/ui'
import { errorMessage, toast } from '../../stores/toast'

/**
 * 角色编辑器里的「立绘」分组：每套服装一组表情格子（酒馆的 28 种 + 自定义），点格子或把图片拖进格子上传。
 * 立绘直接存到服务器（不走编辑器的「保存」），和头像一样即时生效。
 */
export function SpriteManager({ characterId }: { characterId: string }) {
  const sprites = useSprites(characterId)
  const qc = useQueryClient()
  const [outfit, setOutfit] = useState('')
  // 新建了但还没有图片的服装，只存在界面上
  const [draftOutfits, setDraftOutfits] = useState<string[]>([])
  const [customs, setCustoms] = useState<string[]>([])
  const [opened, setOpened] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const zipInput = useRef<HTMLInputElement>(null)
  const batchInput = useRef<HTMLInputElement>(null)

  const list = sprites.data ?? []
  const outfits = [...new Set(['', ...list.map((s) => s.outfit), ...draftOutfits])]
  const mine = list.filter((s) => s.outfit === outfit)
  const byExpression = new Map<string, SpriteDTO[]>()
  for (const s of mine) byExpression.set(s.expression, [...(byExpression.get(s.expression) ?? []), s])
  const builtin = new Set<string>(EXPRESSIONS)
  const extra = [...new Set([...list.map((s) => s.expression), ...customs])].filter((e) => !builtin.has(e)).sort()
  const filled = EXPRESSIONS.filter((e) => byExpression.has(e)).length

  const refresh = () => qc.invalidateQueries({ queryKey: keys.sprites(characterId) })
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      await refresh()
      setBusy(false)
    }
  }
  const report = (result: SpriteImportResult) => {
    toast.info(
      `已导入 ${result.added.length} 张立绘${result.skipped.length ? `，跳过 ${result.skipped.length} 个文件` : ''}`,
    )
    if (result.skipped.length) toast.error(result.skipped.slice(0, 5).join('\n'))
  }
  const upload = (files: File[], expression?: string) => {
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (!images.length) return
    void run(async () =>
      report(await api.uploadSprites(characterId, images, { outfit, ...(expression ? { expression } : {}) })),
    )
  }

  return (
    <Section
      title="立绘"
      description="VN 模式里按表情显示的角色图。透明背景的 PNG 最好；可以直接导入酒馆的立绘包（zip）"
    >
      <div className="space-y-3">
        {/* 服装切换 + 导入 */}
        <div className="flex flex-wrap items-center gap-1.5">
          {outfits.map((name) => (
            <button
              key={name || '__default'}
              type="button"
              aria-pressed={outfit === name}
              onClick={() => setOutfit(name)}
              className={cx(
                'h-8 rounded-lg border px-3 text-[13px] transition-colors',
                outfit === name
                  ? 'border-violet-300 bg-violet-50 font-medium text-violet-700 dark:border-violet-800 dark:bg-violet-950/60 dark:text-violet-300'
                  : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300',
              )}
            >
              {name || '默认服装'}
              <span className="ml-1.5 text-xs text-zinc-400 tabular-nums">
                {list.filter((s) => s.outfit === name).length}
              </span>
            </button>
          ))}
          <IconButton
            label="新建一套服装"
            onClick={() => {
              const name = prompt('服装名称（比如 casual、泳装）')?.trim()
              if (!name) return
              if (!outfits.includes(name)) setDraftOutfits([...draftOutfits, name])
              setOutfit(name)
            }}
          >
            <PlusIcon />
          </IconButton>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" disabled={busy} onClick={() => batchInput.current?.click()}>
              按文件名上传
            </Button>
            <Button size="sm" disabled={busy} onClick={() => zipInput.current?.click()}>
              <UploadIcon />
              导入立绘包
            </Button>
            {outfit && (
              <IconButton
                variant="danger"
                label={`删除服装「${outfit}」`}
                disabled={busy}
                onClick={() => {
                  if (!confirm(`删除服装「${outfit}」和它的全部立绘？`)) return
                  void run(async () => {
                    await api.deleteOutfit(characterId, outfit)
                    setDraftOutfits(draftOutfits.filter((n) => n !== outfit))
                    setOutfit('')
                  })
                }}
              >
                <TrashIcon />
              </IconButton>
            )}
          </div>
          <input
            ref={batchInput}
            type="file"
            accept="image/png,image/webp,image/gif,image/jpeg"
            multiple
            className="hidden"
            aria-label="按文件名批量上传立绘"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              e.target.value = ''
              upload(files)
            }}
          />
          <input
            ref={zipInput}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            aria-label="导入立绘包"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void run(async () => report(await api.importSprites(characterId, file)))
            }}
          />
        </div>

        <p className="text-xs text-zinc-500">
          {filled} / {EXPRESSIONS.length}{' '}
          个表情有图。文件名就是表情名（joy.png、joy-2.png），「按文件名上传」和立绘包都按这个规则；
          立绘包里的一层目录会成为一套服装。
        </p>

        {sprites.isError ? (
          <p className="text-sm text-red-600">{errorMessage(sprites.error)}</p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-2">
            {[...EXPRESSIONS, ...extra].map((expression) => (
              <SpriteCell
                key={expression}
                expression={expression}
                custom={!builtin.has(expression)}
                sprites={byExpression.get(expression) ?? []}
                disabled={busy}
                onUpload={(files) => upload(files, expression)}
                onOpen={() => setOpened(expression)}
              />
            ))}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const name = prompt('自定义表情名（英文，比如 smug）')?.trim().toLowerCase()
                if (!name) return
                if (!/^[a-z0-9_-]+$/.test(name)) {
                  toast.error('表情名只能用英文字母、数字、_ 和 -')
                  return
                }
                setCustoms([...customs, name])
              }}
              className="flex aspect-[3/4] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-zinc-300 text-xs text-zinc-400 transition-colors hover:border-violet-400 hover:text-violet-600 dark:border-zinc-700"
            >
              <PlusIcon className="size-4" />
              自定义表情
            </button>
          </div>
        )}
      </div>

      <ExpressionDialog
        expression={opened}
        sprites={opened ? (byExpression.get(opened) ?? []) : []}
        busy={busy}
        onClose={() => setOpened(null)}
        onUpload={(files) => opened && upload(files, opened)}
        onDelete={(id) => void run(() => api.deleteSprite(characterId, id).then(() => undefined))}
      />
    </Section>
  )
}

/** 一个表情格子：有图显示第一张（多张时角标显示数量），没图是虚线框；点击上传或打开管理，也可以把图片拖进来 */
function SpriteCell({
  expression,
  custom,
  sprites,
  disabled,
  onUpload,
  onOpen,
}: {
  expression: string
  custom: boolean
  sprites: SpriteDTO[]
  disabled: boolean
  onUpload: (files: File[]) => void
  onOpen: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const first = sprites[0]
  const drop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    onUpload(Array.from(e.dataTransfer.files))
  }
  return (
    <div className="min-w-0">
      <button
        type="button"
        disabled={disabled}
        title={first ? `${expression}：${sprites.length} 张，点击管理` : `上传 ${expression} 的立绘`}
        onClick={() => (first ? onOpen() : input.current?.click())}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        className={cx(
          'sprite-cell relative flex aspect-[3/4] w-full items-end justify-center overflow-hidden rounded-lg border transition-colors disabled:opacity-60',
          first
            ? 'border-zinc-200 hover:border-violet-300 dark:border-zinc-700'
            : 'border-dashed border-zinc-300 text-zinc-300 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700 dark:text-zinc-600',
          over && 'border-violet-500 bg-violet-50 dark:bg-violet-950/40',
        )}
      >
        {first ? (
          <img
            src={first.thumbUrl}
            alt={expression}
            loading="lazy"
            className="size-full object-contain object-bottom"
          />
        ) : (
          <PlusIcon className="mb-[40%] size-5" />
        )}
        {sprites.length > 1 && (
          <span className={cx(badgeClass, 'absolute top-1 right-1 bg-zinc-900/70 text-white')}>{sprites.length}</span>
        )}
      </button>
      <p className={cx('mt-1 truncate text-center text-[11px]', custom ? 'text-violet-600' : 'text-zinc-500')}>
        {expression}
      </p>
      <input
        ref={input}
        type="file"
        accept="image/png,image/webp,image/gif,image/jpeg"
        multiple
        className="hidden"
        aria-label={`上传 ${expression} 的立绘`}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          onUpload(files)
        }}
      />
    </div>
  )
}

/** 一个表情的全部立绘：多张时 VN 里随机挑一张显示；可以继续添加或删除单张 */
function ExpressionDialog({
  expression,
  sprites,
  busy,
  onClose,
  onUpload,
  onDelete,
}: {
  expression: string | null
  sprites: SpriteDTO[]
  busy: boolean
  onClose: () => void
  onUpload: (files: File[]) => void
  onDelete: (id: string) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <Dialog open={!!expression} onClose={onClose} title={`${expression ?? ''} · ${sprites.length} 张`}>
      <div className="space-y-3">
        <p className="text-xs text-zinc-500">同一个表情有多张时，VN 里会随机挑一张（可以在玩法预设里关掉随机）。</p>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-3">
          {sprites.map((s) => (
            <div key={s.id} className="group relative">
              <img
                src={s.url}
                alt={expression ?? ''}
                className="sprite-cell aspect-[3/4] w-full rounded-lg border border-zinc-200 object-contain object-bottom dark:border-zinc-700"
              />
              <p className="mt-1 text-center text-[11px] text-zinc-400 tabular-nums">
                {s.width}×{s.height}
              </p>
              <IconButton
                variant="danger"
                label="删除这张"
                disabled={busy}
                className="absolute top-1 right-1 bg-white/90 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus:opacity-100 dark:bg-zinc-900/90"
                onClick={() => {
                  if (confirm('删除这张立绘？')) onDelete(s.id)
                }}
              >
                <TrashIcon />
              </IconButton>
            </div>
          ))}
          <button
            type="button"
            disabled={busy}
            onClick={() => input.current?.click()}
            className="flex aspect-[3/4] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-zinc-300 text-xs text-zinc-400 hover:border-violet-400 hover:text-violet-600 dark:border-zinc-700"
          >
            <PlusIcon className="size-5" />
            再加一张
          </button>
        </div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/webp,image/gif,image/jpeg"
          multiple
          className="hidden"
          aria-label="再加一张立绘"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            onUpload(files)
          }}
        />
      </div>
    </Dialog>
  )
}
