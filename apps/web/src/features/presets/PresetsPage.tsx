import { type PresetData, type PromptPresetDTO, presetDataSchema } from '@ai-parter/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { api } from '../../api/client'
import { keys, usePresets } from '../../api/queries'
import { Tabs } from '../../components/form'
import { CheckIcon, CopyIcon, DownloadIcon, TrashIcon } from '../../components/icons'
import { DetailHeader, ListItem, ManagerLayout } from '../../components/layout'
import { Menu, MenuDivider, MenuEntry } from '../../components/menu'
import { Button, controlClass } from '../../components/ui'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { BehaviorEditor } from './BehaviorEditor'
import { PromptEditor } from './PromptEditor'
import { isExtraBodyValid } from './presetEditor'
import { SamplerEditor } from './SamplerEditor'
import { UtilityEditor } from './UtilityEditor'

type Draft = { name: string; data: PresetData }
const toDraft = (p: PromptPresetDTO): Draft => structuredClone({ name: p.name, data: p.data })

export function PresetsPage() {
  const query = usePresets()
  const qc = useQueryClient()
  const focusId = useUi((s) => s.focusId)
  const [original, setOriginal] = useState<PromptPresetDTO | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'samplers' | 'prompts' | 'utility' | 'behavior'>('samplers')
  const fileInput = useRef<HTMLInputElement>(null)
  const dirty = !!draft && !!original && JSON.stringify(draft) !== JSON.stringify(toDraft(original))
  const canLeave = () => !dirty || confirm('此预设有未保存的修改，是否放弃？')
  const pick = (p: PromptPresetDTO | null) => {
    setOriginal(p ? structuredClone(p) : null)
    setDraft(p ? toDraft(p) : null)
  }
  const handleFocus = useEffectEvent((id: string) => {
    const p = query.data?.find((item) => item.id === id)
    if (!p || busy) return
    if (p.id !== original?.id && canLeave()) pick(p)
    useUi.getState().openView('presets')
  })
  useEffect(() => {
    if (focusId && query.data && !busy) handleFocus(focusId)
  }, [focusId, query.data, busy])
  const refresh = () => qc.invalidateQueries({ queryKey: keys.presets })
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
  const create = () => {
    if (!canLeave()) return
    void run(async () => {
      const saved = await api.createPreset({ name: '新预设', data: presetDataSchema.parse({}) })
      pick(saved)
      await refresh()
    })
  }
  const setData = <K extends keyof PresetData>(key: K, value: PresetData[K]) => {
    if (draft) setDraft({ ...draft, data: { ...draft.data, [key]: value } })
  }
  const current = query.data?.find((p) => p.id === original?.id) ?? original
  return (
    <ManagerLayout
      title="生成预设"
      showDetailOnMobile={!!draft}
      actions={
        <>
          <Button disabled={busy} onClick={create}>
            新建
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              fileInput.current?.click()
            }}
          >
            导入
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".json"
            className="hidden"
            aria-label="导入酒馆预设"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file && canLeave())
                void run(async () => {
                  const saved = await api.importPreset(file)
                  pick(saved)
                  await refresh()
                  toast.info('已导入预设')
                })
            }}
          />
        </>
      }
      list={
        <>
          {query.isPending && <p className="p-3 text-sm text-zinc-500">加载中…</p>}
          {query.isError && (
            <p role="alert" className="p-3 text-sm text-red-600">
              {errorMessage(query.error)}
            </p>
          )}
          {query.data?.length === 0 && (
            <p className="p-3 text-sm text-zinc-500">还没有预设，点击「新建」或「导入」开始。</p>
          )}
          {query.data?.map((p) => (
            <ListItem
              key={p.id}
              active={p.id === original?.id}
              onClick={() => {
                if (!busy && p.id !== original?.id && canLeave()) pick(p)
              }}
            >
              <span className="truncate">{p.name}</span>
              {p.isDefault && (
                <span className="shrink-0 rounded bg-violet-100 px-1.5 text-xs text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                  默认
                </span>
              )}
            </ListItem>
          ))}
        </>
      }
      detail={
        draft && original ? (
          <>
            <DetailHeader
              title={
                <input
                  aria-label="预设名称"
                  title="预设名称：用于在列表中辨认这组生成设置"
                  className={`${controlClass} h-8 max-w-md min-w-0 font-semibold`}
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
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || !dirty}
                    onClick={() => setDraft(toDraft(original))}
                  >
                    撤销修改
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy || !dirty || !draft.name.trim() || !isExtraBodyValid(draft.data.samplers.extraBody)}
                    onClick={() =>
                      void run(async () => {
                        const parsed = presetDataSchema.safeParse(draft.data)
                        if (!parsed.success) {
                          toast.error('预设参数无效，请检查数字范围和 Prompt 设置')
                          return
                        }
                        const saved = await api.updatePreset(original.id, {
                          name: draft.name.trim(),
                          data: parsed.data,
                        })
                        pick(saved)
                        await refresh()
                        toast.info('已保存')
                      })
                    }
                  >
                    保存
                  </Button>
                  <Menu>
                    {!current?.isDefault && (
                      <MenuEntry
                        icon={<CheckIcon />}
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api.setDefaultPreset(original.id)
                            await refresh()
                            toast.info('已设为默认预设')
                          })
                        }
                      >
                        设为默认
                      </MenuEntry>
                    )}
                    <MenuEntry
                      icon={<CopyIcon />}
                      disabled={busy}
                      onClick={() => {
                        if (canLeave())
                          void run(async () => {
                            const saved = await api.duplicatePreset(original.id)
                            pick(saved)
                            await refresh()
                          })
                      }}
                    >
                      复制
                    </MenuEntry>
                    <MenuEntry icon={<DownloadIcon />} disabled={busy} onClick={() => api.exportPreset(original.id)}>
                      导出
                    </MenuEntry>
                    <MenuDivider />
                    <MenuEntry
                      icon={<TrashIcon />}
                      danger
                      disabled={busy}
                      onClick={() => {
                        if (confirm(`删除预设「${original.name}」？该预设及未保存的修改都会被删除。`))
                          void run(async () => {
                            await api.deletePreset(original.id)
                            pick(null)
                            await refresh()
                          })
                      }}
                    >
                      删除
                    </MenuEntry>
                  </Menu>
                </div>
              }
            />
            <fieldset disabled={busy} className="mx-auto w-full max-w-6xl min-w-0 space-y-3 p-3 sm:p-4">
              <div className="overflow-x-auto">
                <Tabs
                  value={tab}
                  onChange={setTab}
                  tabs={[
                    { id: 'samplers', label: '参数' },
                    { id: 'prompts', label: 'Prompt 管理器' },
                    { id: 'utility', label: '辅助提示词' },
                    { id: 'behavior', label: '行为' },
                  ]}
                />
              </div>
              {tab === 'samplers' && (
                <SamplerEditor value={draft.data.samplers} onChange={(v) => setData('samplers', v)} />
              )}
              {tab === 'prompts' && (
                <PromptEditor key={original.id} value={draft.data.prompts} onChange={(v) => setData('prompts', v)} />
              )}
              {tab === 'utility' && (
                <UtilityEditor value={draft.data.utility} onChange={(v) => setData('utility', v)} />
              )}
              {tab === 'behavior' && (
                <BehaviorEditor value={draft.data.behavior} onChange={(v) => setData('behavior', v)} />
              )}
            </fieldset>
          </>
        ) : null
      }
    />
  )
}
