import type { ExtensionCatalogItem, ExtensionDTO } from '@nobot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { useReloadExtensions } from '../../api/extensionManager'
import { keys, useExtensions } from '../../api/queries'
import { Tabs, Toggle } from '../../components/form'
import { PlusIcon, RefreshIcon } from '../../components/icons'
import { DetailHeader, EmptyDetail, ManagerLayout } from '../../components/layout'
import { Button, badgeClass, cx, IconButton } from '../../components/ui'
import { loadExtensions, useExtensionsRuntime } from '../../extensions/runtime'
import { ExtensionPage, Slot } from '../../extensions/Slot'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { ApprovalDialog, CatalogList, GitPanel, InstallDialog, PermissionList } from './ExtensionManagerUi'
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
  requestApproval,
}: {
  extension: ExtensionDTO
  onBack: () => void
  onDirtyChange: (dirty: boolean) => void
  update: UpdateExtension
  busy: boolean
  /** 启用需要确认权限的扩展时，交给页面弹出确认框 */
  requestApproval: (extension: ExtensionDTO) => void
}) {
  const pages = useExtensionsRuntime((s) => s.pages).filter((page) => page.extensionId === extension.id)
  const pageId = useUi((s) => s.extensionPageId)
  const openView = useUi((s) => s.openView)
  const activePage = extension.enabled ? pages.find((page) => page.id === pageId) : undefined
  const tabs = [{ id: null, label: t('设置'), icon: '' }, ...pages]
  const [draft, setDraft] = useState(() => structuredClone(extension.settings))
  const dirty = JSON.stringify(draft) !== JSON.stringify(extension.settings)
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  async function save() {
    try {
      const saved = await update(extension.id, { settings: draft })
      setDraft(structuredClone(saved.settings))
      toast.info(t('扩展设置已保存'))
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
                {t('撤销修改')}
              </Button>
              <Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
                {t('保存')}
              </Button>
            </div>
          }
        />
        {pages.length > 0 && (
          <div
            role="tablist"
            aria-label={t('{name}详情', { name: extension.name })}
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
        <div hidden={!!activePage} className="mx-auto w-full max-w-6xl space-y-3 p-3 sm:p-4">
          {/* 扩展概要：名字、说明、元信息、启用开关放在一张卡片里，不再上下重复 */}
          <div className="rounded-xl border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/40">
            <div className="flex items-start gap-4">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <h2 className="mr-1 break-words text-base font-semibold">{extension.name}</h2>
                  <span className={badgeClass}>v{extension.version}</span>
                  <span className={badgeClass}>{extension.source === 'builtin' ? t('内置') : t('本地')}</span>
                  {extension.author && <span className={badgeClass}>{extension.author}</span>}
                </div>
                <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-zinc-500">
                  {extension.description || t('暂无描述。')}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2 pt-0.5">
                <span className="text-xs text-zinc-500">{extension.enabled ? t('已启用') : t('已停用')}</span>
                <Toggle
                  label={t('启用{name}', { name: extension.name })}
                  checked={extension.enabled}
                  disabled={busy}
                  onChange={(enabled) => {
                    if (enabled && extension.needsApproval) requestApproval(extension)
                    else void update(extension.id, { enabled }).catch((e: unknown) => toast.error(errorMessage(e)))
                  }}
                />
              </div>
            </div>
            {(() => {
              const provided = [
                ...extension.provides.tools.map((name) => ({ kind: t('工具'), name })),
                ...extension.provides.macros.map((name) => ({ kind: t('宏'), name: `{{${name}}}` })),
                ...extension.provides.hooks.map((name) => ({ kind: t('钩子'), name })),
                ...(extension.hasRoutes ? [{ kind: t('接口'), name: `/api/ext/${extension.id}/` }] : []),
                ...(extension.client.script || extension.client.style ? [{ kind: t('前端'), name: t('界面') }] : []),
              ]
              return (
                provided.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5 border-t border-zinc-100 pt-2 dark:border-zinc-800">
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
          {extension.needsApproval && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-[13px] text-violet-800 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-300">
              <span className="min-w-0 flex-1">
                {extension.enabled ? t('权限有变化，确认前扩展暂不生效。') : t('首次启用前需要确认这个扩展的权限。')}
              </span>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => requestApproval(extension)}>
                {t('查看并确认')}
              </Button>
            </div>
          )}
          {extension.source === 'local' && !extension.loadError && (
            <div className="space-y-3 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/40">
              <GitPanel
                extension={extension}
                onUninstalled={onBack}
                onPermissionsChanged={(next) => {
                  toast.info(t('更新后权限有变化，扩展已暂停，请重新确认'))
                  requestApproval(next)
                }}
              />
              <details
                className="group border-t border-zinc-100 pt-2 dark:border-zinc-800"
                open={extension.permissionWarnings.length > 0}
              >
                <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium text-zinc-700 dark:text-zinc-300">
                  {t('权限')}
                  {extension.permissionWarnings.length > 0 && (
                    <span className="rounded bg-amber-100 px-1 text-[11px] font-normal text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                      {t('{count} 条警告', { count: extension.permissionWarnings.length })}
                    </span>
                  )}
                  <span className="ml-auto text-xs font-normal text-zinc-400 group-open:hidden">{t('展开')}</span>
                </summary>
                <div className="pt-2">
                  <PermissionList
                    declared={extension.permissions}
                    detected={extension.detected}
                    warnings={extension.permissionWarnings}
                  />
                </div>
              </details>
            </div>
          )}
          {extension.loadError && (
            <div
              role="alert"
              className="rounded-lg border border-red-300 bg-red-50 p-3 whitespace-pre-wrap break-words text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
            >
              {t('加载失败：{error}', { error: extension.loadError })}
            </div>
          )}
          {dirty && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300">
              <span className="size-1.5 rounded-full bg-amber-500" />
              {t('有未保存的修改，点右上角「保存」生效')}
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
            <p className="text-sm text-zinc-500">{t('此扩展没有可配置的设置。')}</p>
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
  const [tab, setTab] = useState<'installed' | 'catalog'>('installed')
  const [installing, setInstalling] = useState<{ url: string; ref?: string | undefined } | null>(null)
  const [approving, setApproving] = useState<ExtensionDTO | null>(null)
  const reload = useReloadExtensions()
  const extension = query.data?.find((item) => item.id === selectedId)
  const installFromCatalog = (item: ExtensionCatalogItem) => setInstalling({ url: item.repo, ref: item.ref })

  function select(id: string | null, pageId?: string) {
    if (busy) return
    if (id === selectedId) {
      if (pageId) openView(`ext:${id}:${pageId}`)
      else openView('extensions', id)
      return
    }
    if (dirty && !confirm(t('当前扩展有未保存的设置，确定放弃这些修改并切换吗？'))) return
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
        ...(id === 'audio' ? [qc.invalidateQueries({ queryKey: ['tts'] })] : []),
      ])
      await loadExtensions(qc, id)
      return result
    } finally {
      setBusy(false)
    }
  }

  async function toggle(item: ExtensionDTO, enabled: boolean) {
    if (enabled && item.needsApproval) {
      setApproving(item)
      return
    }
    try {
      await update(item.id, { enabled })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <ManagerLayout
      title={t('扩展')}
      showDetailOnMobile={selectedId !== null}
      actions={
        <div className="flex items-center gap-1">
          <IconButton
            label={t('重新扫描扩展目录')}
            disabled={busy || reload.busy}
            onClick={() =>
              void reload
                .reload()
                .then((list) => toast.info(t('已重新加载，共 {count} 个扩展', { count: list.length })))
                .catch((e: unknown) => toast.error(errorMessage(e)))
            }
          >
            <RefreshIcon className={reload.busy ? 'animate-spin' : ''} />
          </IconButton>
          <Button disabled={busy} onClick={() => setInstalling({ url: '' })}>
            <PlusIcon className="size-4" />
            {t('安装')}
          </Button>
        </div>
      }
      list={
        <>
          <div className="mb-2 px-1">
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'installed', label: t('已安装') },
                { id: 'catalog', label: t('扩展目录') },
              ]}
            />
          </div>
          {tab === 'catalog' ? (
            <div className="px-1">
              <CatalogList onInstall={installFromCatalog} />
            </div>
          ) : query.isPending ? (
            <p className="p-2 text-sm">{t('加载中…')}</p>
          ) : query.isError ? (
            <p role="alert" className="p-2 text-sm text-red-600">
              {errorMessage(query.error)}
            </p>
          ) : query.data.length === 0 ? (
            <p className="p-2 text-sm text-zinc-500">{t('暂无扩展。可在下方说明的目录中安装本地扩展。')}</p>
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
                  label={t('启用{name}', { name: item.name })}
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
                        label={t('打开{name}：{pageLabel}', { name: item.name, pageLabel: page.label })}
                        className="shrink-0"
                        disabled={busy}
                        onClick={() => select(item.id, page.id)}
                      >
                        {page.icon || page.label.slice(0, 1)}
                      </IconButton>
                    ))}
                {item.git?.hasUpdate && (
                  <span
                    className="size-2 shrink-0 rounded-full bg-violet-500"
                    title={t('有新版本')}
                    role="img"
                    aria-label={t('有新版本')}
                  />
                )}
                <span
                  className={cx(badgeClass, 'shrink-0', item.needsApproval && 'text-amber-700 dark:text-amber-300')}
                  title={item.loadError || undefined}
                >
                  {item.loadError
                    ? t('失败')
                    : item.needsApproval
                      ? t('待确认')
                      : item.source === 'builtin'
                        ? t('内置')
                        : item.git
                          ? 'Git'
                          : t('本地')}
                </span>
              </div>
            ))
          )}
          {tab === 'installed' && (
            <p className="mt-4 px-2 text-xs leading-relaxed text-zinc-500">
              {t('点「安装」从 Git 地址安装，或把扩展放进')}
              <code className="break-all">{t('data/extensions/<目录>/manifest.json')}</code>
              {t('后点刷新按钮加载。扩展代码在后端和浏览器中运行，只安装你信任的扩展。')}
            </p>
          )}
          <InstallDialog
            open={!!installing}
            initial={installing ?? undefined}
            onClose={() => setInstalling(null)}
            onInstalled={(installed) => {
              setTab('installed')
              select(installed.id)
            }}
          />
          <ApprovalDialog extension={approving} onClose={() => setApproving(null)} />
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
            requestApproval={setApproving}
          />
        ) : (
          <>
            {selectedId && <DetailHeader title={t('扩展详情')} onBack={() => select(null)} />}
            <div className="space-y-4 p-4 sm:p-6">
              {query.isPending ? (
                <p>{t('加载中…')}</p>
              ) : query.isError ? (
                <p role="alert" className="text-sm text-red-600">
                  {errorMessage(query.error)}
                </p>
              ) : (
                <EmptyDetail
                  text={selectedId ? t('未找到此扩展，请从列表重新选择') : t('选择一个扩展，查看能力并编辑设置')}
                />
              )}
            </div>
          </>
        )
      }
    />
  )
}
