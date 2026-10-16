import type { ExtensionDTO } from '@ai-parter/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { keys, useExtensions } from '../../api/queries'
import { Section, Toggle } from '../../components/form'
import { DetailHeader, EmptyDetail, ManagerLayout } from '../../components/layout'
import { Button, badgeClass, cx, IconButton } from '../../components/ui'
import { loadExtensions, useExtensionsRuntime } from '../../extensions/runtime'
import { ExtensionPage, Slot } from '../../extensions/Slot'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { SettingsEditor } from './SettingsEditor'

type UpdateExtension = (
  id: string,
  patch: { enabled?: boolean; settings?: Record<string, unknown> },
) => Promise<ExtensionDTO>

export function ExtensionDetail({
  extension,
  onBack,
  onDirtyChange,
  update,
  busy,
}: {
  extension: ExtensionDTO
  onBack: () => void
  onDirtyChange: (dirty: boolean) => void
  update: UpdateExtension
  busy: boolean
}) {
  const pages = useExtensionsRuntime((s) => s.pages).filter((page) => page.extensionId === extension.id)
  const pageId = useUi((s) => s.extensionPageId)
  const openView = useUi((s) => s.openView)
  const activePage = extension.enabled ? pages.find((page) => page.id === pageId) : undefined
  const tabs = [{ id: null, label: '设置', icon: '' }, ...pages]
  const [draft, setDraft] = useState(() => structuredClone(extension.settings))
  const dirty = JSON.stringify(draft) !== JSON.stringify(extension.settings)
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  async function save() {
    try {
      const saved = await update(extension.id, { settings: draft })
      setDraft(structuredClone(saved.settings))
      toast.info('扩展设置已保存')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="sticky top-0 z-10 shrink-0 bg-white dark:bg-zinc-950">
        <DetailHeader
          title={extension.name}
          onBack={onBack}
          actions={
            <div className="flex gap-1">
              <Button disabled={!dirty || busy} onClick={() => setDraft(structuredClone(extension.settings))}>
                撤销修改
              </Button>
              <Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
                保存
              </Button>
            </div>
          }
        />
        {pages.length > 0 && (
          <div
            role="tablist"
            aria-label={`${extension.name}详情`}
            className="flex gap-1 overflow-x-auto border-b border-zinc-200 px-3 dark:border-zinc-800"
          >
            {tabs.map((tab, index) => (
              <Button
                variant="ghost"
                key={index}
                id={`extension-${extension.id}-tab-${index}`}
                type="button"
                role="tab"
                aria-selected={(activePage?.id ?? null) === tab.id}
                tabIndex={(activePage?.id ?? null) === tab.id ? 0 : -1}
                aria-controls={`extension-${extension.id}-panel`}
                className={cx(
                  '-mb-px h-11 shrink-0 gap-1.5 rounded-none border-b-2 px-3 text-sm',
                  (activePage?.id ?? null) === tab.id
                    ? 'border-violet-600 text-violet-700 hover:bg-transparent dark:text-violet-300'
                    : 'border-transparent text-zinc-500 hover:bg-transparent hover:text-zinc-900 dark:hover:text-zinc-100',
                )}
                onClick={() =>
                  tab.id === null ? openView('extensions', extension.id) : openView(`ext:${extension.id}:${tab.id}`)
                }
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                  event.preventDefault()
                  const next =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
                  const target = event.currentTarget.parentElement?.children[next]
                  if (target instanceof HTMLButtonElement) {
                    target.focus()
                    target.click()
                  }
                }}
              >
                {tab.icon && <span aria-hidden="true">{tab.icon}</span>}
                {tab.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      <div
        id={`extension-${extension.id}-panel`}
        {...(pages.length > 0
          ? {
              role: 'tabpanel',
              'aria-labelledby': `extension-${extension.id}-tab-${activePage ? pages.indexOf(activePage) + 1 : 0}`,
            }
          : {})}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto"
      >
        {activePage && <ExtensionPage view={`ext:${extension.id}:${activePage.id}`} />}
        {/* 保留设置草稿，切换标签不会丢失尚未保存的修改。 */}
        <div hidden={!!activePage} className="mx-auto w-full max-w-3xl space-y-5 p-4 sm:p-6">
          {/* 扩展概要：名字、说明、元信息、启用开关放在一张卡片里，不再上下重复 */}
          <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
            <div className="flex items-start gap-4">
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <h2 className="mr-1 break-words text-base font-semibold">{extension.name}</h2>
                  <span className={badgeClass}>v{extension.version}</span>
                  <span className={badgeClass}>{extension.source === 'builtin' ? '内置' : '本地'}</span>
                  {extension.author && <span className={badgeClass}>{extension.author}</span>}
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-500">
                  {extension.description || '暂无描述。'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2 pt-0.5">
                <span className="text-xs text-zinc-500">{extension.enabled ? '已启用' : '已停用'}</span>
                <Toggle
                  label={`启用${extension.name}`}
                  checked={extension.enabled}
                  disabled={busy}
                  onChange={(enabled) =>
                    void update(extension.id, { enabled }).catch((e: unknown) => toast.error(errorMessage(e)))
                  }
                />
              </div>
            </div>
            {(() => {
              const provided = [
                ...extension.provides.tools.map((name) => ({ kind: '工具', name })),
                ...extension.provides.macros.map((name) => ({ kind: '宏', name: `{{${name}}}` })),
                ...extension.provides.hooks.map((name) => ({ kind: '钩子', name })),
                ...(extension.hasRoutes ? [{ kind: '接口', name: `/api/ext/${extension.id}/` }] : []),
                ...(extension.client.script || extension.client.style ? [{ kind: '前端', name: '界面' }] : []),
              ]
              return (
                provided.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                    {provided.map((item) => (
                      <span key={`${item.kind}:${item.name}`} className={cx(badgeClass, 'gap-1 font-normal')}>
                        <span className="text-zinc-400">{item.kind}</span>
                        <span className="break-all font-mono">{item.name}</span>
                      </span>
                    ))}
                  </div>
                )
              )
            })()}
          </div>
          {extension.loadError && (
            <div
              role="alert"
              className="rounded-lg border border-red-300 bg-red-50 p-3 whitespace-pre-wrap break-words text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
            >
              加载失败：{extension.loadError}
            </div>
          )}
          {dirty && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300">
              <span className="size-1.5 rounded-full bg-amber-500" />
              有未保存的修改，点右上角「保存」生效
            </div>
          )}
          {extension.settingsSchema.length > 0 ? (
            <SettingsEditor
              fields={extension.settingsSchema}
              values={draft}
              onChange={setDraft}
              disabled={busy}
              extensionId={extension.id}
            />
          ) : (
            <p className="text-sm text-zinc-500">此扩展没有可配置的设置。</p>
          )}
          <Slot
            name="extensions.settings.footer"
            props={{ extensionId: extension.id, settings: draft, onSettingsChange: setDraft }}
          />
        </div>
      </div>
    </div>
  )
}

export function ExtensionsPage() {
  const query = useExtensions()
  const qc = useQueryClient()
  const selectedId = useUi((s) => s.focusId)
  const openView = useUi((s) => s.openView)
  const pages = useExtensionsRuntime((s) => s.pages)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const extension = query.data?.find((item) => item.id === selectedId)

  function select(id: string | null, pageId?: string) {
    if (busy) return
    if (id === selectedId) {
      if (pageId) openView(`ext:${id}:${pageId}`)
      else openView('extensions', id)
      return
    }
    if (dirty && !confirm('当前扩展有未保存的设置，确定放弃这些修改并切换吗？')) return
    setDirty(false)
    if (pageId && id) openView(`ext:${id}:${pageId}`)
    else openView('extensions', id)
  }

  async function update(id: string, patch: { enabled?: boolean; settings?: Record<string, unknown> }) {
    setBusy(true)
    try {
      const result = await api.updateExtension(id, patch)
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.extensions }),
        qc.invalidateQueries({ queryKey: keys.tools }),
      ])
      await loadExtensions(qc, id)
      return result
    } finally {
      setBusy(false)
    }
  }

  async function toggle(item: ExtensionDTO, enabled: boolean) {
    try {
      await update(item.id, { enabled })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <ManagerLayout
      title="扩展"
      showDetailOnMobile={selectedId !== null}
      list={
        <>
          {query.isPending ? (
            <p className="p-2 text-sm">加载中…</p>
          ) : query.isError ? (
            <p role="alert" className="p-2 text-sm text-red-600">
              {errorMessage(query.error)}
            </p>
          ) : query.data.length === 0 ? (
            <p className="p-2 text-sm text-zinc-500">暂无扩展。可在下方说明的目录中安装本地扩展。</p>
          ) : (
            query.data.map((item) => (
              <div
                key={item.id}
                className={cx(
                  'flex h-11 items-center gap-2 rounded-lg px-2',
                  selectedId === item.id
                    ? 'bg-violet-100 dark:bg-violet-950'
                    : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60',
                )}
              >
                <Toggle
                  label={`启用${item.name}`}
                  checked={item.enabled}
                  disabled={busy}
                  onChange={(enabled) => void toggle(item, enabled)}
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-sm font-medium"
                  title={item.name}
                  onClick={() => select(item.id)}
                >
                  {item.name}
                </button>
                {item.enabled &&
                  pages
                    .filter((page) => page.extensionId === item.id)
                    .map((page) => (
                      <IconButton
                        key={page.id}
                        label={`打开${item.name}：${page.label}`}
                        className="shrink-0"
                        disabled={busy}
                        onClick={() => select(item.id, page.id)}
                      >
                        {page.icon || page.label.slice(0, 1)}
                      </IconButton>
                    ))}
                <span className={`${badgeClass} shrink-0`} title={item.loadError || undefined}>
                  {item.loadError ? '失败' : item.source === 'builtin' ? '内置' : '本地'}
                </span>
              </div>
            ))
          )}
          <p className="mt-4 px-2 text-xs leading-relaxed text-zinc-500">
            第三方扩展放在 <code className="break-all">data/extensions/&lt;目录&gt;/manifest.json</code>
            ，重启后加载。扩展代码在后端和浏览器中运行，只安装你信任的扩展。
          </p>
        </>
      }
      detail={
        extension ? (
          <ExtensionDetail
            key={extension.id}
            extension={extension}
            onBack={() => select(null)}
            onDirtyChange={setDirty}
            update={update}
            busy={busy}
          />
        ) : (
          <>
            {selectedId && <DetailHeader title="扩展详情" onBack={() => select(null)} />}
            <div className="space-y-4 p-4 sm:p-6">
              {query.isPending ? (
                <p>加载中…</p>
              ) : query.isError ? (
                <p role="alert" className="text-sm text-red-600">
                  {errorMessage(query.error)}
                </p>
              ) : (
                <EmptyDetail
                  text={selectedId ? '未找到此扩展，请从列表重新选择' : '选择一个扩展，查看能力并编辑设置'}
                />
              )}
            </div>
          </>
        )
      }
    />
  )
}
