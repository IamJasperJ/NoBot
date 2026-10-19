import { type PlayPresetData, type PlayPresetDTO, playPresetDataSchema } from '@nobot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useRef, useState } from 'react'
import { api } from '../../api/client'
import { keys, usePlayPresets } from '../../api/queries'
import { CheckIcon, CopyIcon, DownloadIcon, PlusIcon, RefreshIcon, TrashIcon, UploadIcon } from '../../components/icons'
import { DetailHeader, ListItem } from '../../components/layout'
import { Menu, MenuDivider, MenuEntry } from '../../components/menu'
import { Button, badgeClass, controlClass, cx, IconButton } from '../../components/ui'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'
import { PlayPresetEditor } from './PlayPresetEditor'

type Draft = { name: string; data: PlayPresetData }
const toDraft = (p: PlayPresetDTO): Draft => structuredClone({ name: p.name, data: p.data })

/**
 * 设置页里的「玩法预设」：列表放在侧栏（list），选中后编辑器在覆盖层里打开（detail）。
 * 玩法预设决定 VN 模式的一切（指令、变量、立绘、VN 视图……），每个会话绑定一个。
 */
export function usePlayPresetPanel(): { list: ReactNode; detail: ReactNode; open: boolean } {
  const query = usePlayPresets()
  const qc = useQueryClient()
  const [original, setOriginal] = useState<PlayPresetDTO | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const dirty = !!draft && !!original && JSON.stringify(draft) !== JSON.stringify(toDraft(original))
  const canLeave = () => !dirty || confirm(t('这个玩法预设有未保存的修改，是否放弃？'))
  const pick = (p: PlayPresetDTO | null) => {
    setOriginal(p ? structuredClone(p) : null)
    setDraft(p ? toDraft(p) : null)
  }
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: keys.playPresets }),
      // 会话页里的「实际生效的预设」和舞台都可能跟着变
      qc.invalidateQueries({ queryKey: ['chat'] }),
    ])
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const current = query.data?.find((p) => p.id === original?.id) ?? original

  const list = (
    <section className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40">
      <header className="flex items-center gap-1 py-1.5 pr-1.5 pl-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{t('玩法预设')}</h2>
          <p className="truncate text-xs text-zinc-500">{t('VN 模式：指令、变量、立绘、跑团')}</p>
        </div>
        <IconButton
          label={t('补回被删掉的内置预设')}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const { restored } = await api.restoreBuiltinPlayPresets()
              await refresh()
              toast.info(restored ? t('已补回 {restored} 个内置预设', { restored }) : t('内置预设都在，没有需要补回的'))
            })
          }
        >
          <RefreshIcon />
        </IconButton>
        <IconButton
          label={t('导入玩法预设')}
          disabled={busy}
          onClick={() => {
            if (canLeave()) fileInput.current?.click()
          }}
        >
          <UploadIcon />
        </IconButton>
        <IconButton
          label={t('新建玩法预设')}
          disabled={busy}
          onClick={() => {
            if (canLeave())
              void run(async () => {
                const saved = await api.createPlayPreset({ name: t('新玩法'), data: playPresetDataSchema.parse({}) })
                pick(saved)
                await refresh()
              })
          }}
        >
          <PlusIcon />
        </IconButton>
        <input
          ref={fileInput}
          type="file"
          accept=".json"
          className="hidden"
          aria-label={t('导入玩法预设文件')}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file)
              void run(async () => {
                const saved = await api.importPlayPreset(file)
                pick(saved)
                await refresh()
                toast.info(t('已导入玩法预设'))
              })
          }}
        />
      </header>
      <div className="border-t border-zinc-100 p-1 dark:border-zinc-800">
        {query.isPending && <p className="px-2 py-1.5 text-sm text-zinc-500">{t('加载中…')}</p>}
        {query.isError && (
          <p role="alert" className="px-2 py-1.5 text-sm text-red-600">
            {errorMessage(query.error)}
          </p>
        )}
        {query.data?.map((p) => (
          <ListItem
            key={p.id}
            active={p.id === original?.id}
            onClick={() => {
              if (!busy && p.id !== original?.id && canLeave()) pick(p)
            }}
          >
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            {!p.data.directives.enabled && <span className="shrink-0 text-xs text-zinc-400">{t('不启用指令')}</span>}
            {p.isDefault && (
              <span className={cx(badgeClass, 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300')}>
                {t('默认')}
              </span>
            )}
          </ListItem>
        ))}
      </div>
    </section>
  )

  const detail =
    draft && original ? (
      <>
        <DetailHeader
          title={
            <input
              aria-label={t('玩法预设名称')}
              className={cx(controlClass, 'h-8 max-w-md min-w-0 font-semibold')}
              value={draft.name}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          }
          onBack={() => {
            if (!busy && canLeave()) pick(null)
          }}
          actions={
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="ghost" disabled={busy || !dirty} onClick={() => setDraft(toDraft(original))}>
                {t('撤销修改')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={busy || !dirty || !draft.name.trim()}
                onClick={() =>
                  void run(async () => {
                    const parsed = playPresetDataSchema.safeParse(draft.data)
                    if (!parsed.success) {
                      toast.error(t('有设置项超出范围，请检查数字'))
                      return
                    }
                    const saved = await api.updatePlayPreset(original.id, {
                      name: draft.name.trim(),
                      data: parsed.data,
                    })
                    pick(saved)
                    await refresh()
                    toast.info(t('已保存'))
                  })
                }
              >
                {t('保存')}
              </Button>
              <Menu>
                {!current?.isDefault && (
                  <MenuEntry
                    icon={<CheckIcon />}
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api.setDefaultPlayPreset(original.id)
                        await refresh()
                        toast.info(t('已设为默认：新会话和没指定预设的会话都会用它'))
                      })
                    }
                  >
                    {t('设为默认')}
                  </MenuEntry>
                )}
                <MenuEntry
                  icon={<CopyIcon />}
                  disabled={busy}
                  onClick={() => {
                    if (canLeave())
                      void run(async () => {
                        const saved = await api.duplicatePlayPreset(original.id)
                        pick(saved)
                        await refresh()
                      })
                  }}
                >
                  {t('复制')}
                </MenuEntry>
                {current?.builtin && (
                  <MenuEntry
                    icon={<RefreshIcon />}
                    disabled={busy}
                    onClick={() => {
                      if (confirm(t('把「{name}」的名字和全部设置恢复成内置默认？', { name: original.name })))
                        void run(async () => {
                          pick(await api.resetPlayPreset(original.id))
                          await refresh()
                          toast.info(t('已恢复内置默认'))
                        })
                    }}
                  >
                    {t('重置为内置默认')}
                  </MenuEntry>
                )}
                <MenuEntry icon={<DownloadIcon />} disabled={busy} onClick={() => api.exportPlayPreset(original.id)}>
                  {t('导出')}
                </MenuEntry>
                <MenuDivider />
                <MenuEntry
                  icon={<TrashIcon />}
                  danger
                  disabled={busy}
                  onClick={() => {
                    if (confirm(t('删除玩法预设「{name}」？用到它的会话会改为跟随默认。', { name: original.name })))
                      void run(async () => {
                        await api.deletePlayPreset(original.id)
                        pick(null)
                        await refresh()
                      })
                  }}
                >
                  {t('删除')}
                </MenuEntry>
              </Menu>
            </div>
          }
        />
        <fieldset disabled={busy} className="mx-auto w-full max-w-6xl min-w-0 space-y-2 p-3 sm:p-4">
          {current?.builtin && (
            <p className="text-xs text-zinc-500">
              {t('内置预设，可以直接修改。想保留原样的话，先在右上角 ⋯ 里「复制」一份再改。')}
            </p>
          )}
          <p className="flex items-center gap-1.5 text-xs text-zinc-500">
            <span className="inline-block size-1.5 rounded-full bg-amber-500" />
            {t('带黄点的设置项还没实现：现在就可以设置和保存，对应的那一期做完后生效。每项的说明在标签旁的 ⓘ 里。')}
          </p>
          <PlayPresetEditor value={draft.data} onChange={(data) => setDraft({ ...draft, data })} />
        </fieldset>
      </>
    ) : null

  return { list, detail, open: !!draft }
}
