import type {
  ExtensionCatalogItem,
  ExtensionDTO,
  ExtensionInstallPreview,
  ExtensionPermissions,
} from '@ai-parter/shared'
import { useEffect, useState } from 'react'
import {
  useApproveExtension,
  useCatalogSources,
  useExtensionCatalog,
  useExtensionGit,
  useGitStatus,
  useInstallFlow,
} from '../../api/extensionManager'
import { BranchIcon, DownloadIcon, RefreshIcon, SearchIcon, TrashIcon } from '../../components/icons'
import { Menu, MenuDivider, MenuEntry } from '../../components/menu'
import { Button, badgeClass, controlClass, cx, Dialog, Field, IconButton, inputClass } from '../../components/ui'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'

// ───────────────────────── 权限 ─────────────────────────

type Capability = keyof Omit<ExtensionPermissions, 'network'>

const capabilityText = (key: Capability) => {
  switch (key) {
    case 'server':
      return { title: t('运行后端代码'), detail: t('在服务器进程里执行，能读写本机文件和数据库') }
    case 'client':
      return { title: t('运行前端脚本'), detail: t('在浏览器页面里执行脚本或注入样式') }
    case 'routes':
      return { title: t('注册接口'), detail: t('提供 /api/ext/ 下的自定义接口') }
    case 'tools':
      return { title: t('提供工具'), detail: t('模型在对话中可以调用它提供的工具') }
    case 'hooks':
      return { title: t('介入生成流程'), detail: t('可以改写提示词、用户输入和模型输出') }
  }
}

const CAPABILITIES: Capability[] = ['server', 'client', 'routes', 'tools', 'hooks']

/**
 * 权限清单：声明的权限逐项列出，检测到但未声明的标成警告色；网络域名单独列出。
 * declared 为 null 表示扩展没有声明，按检测到的能力展示
 */
export function PermissionList({
  declared,
  detected,
  warnings,
}: {
  declared: ExtensionPermissions | null
  detected: Partial<Record<Capability, boolean>>
  warnings: string[]
}) {
  const rows = CAPABILITIES.filter((key) => declared?.[key] || detected[key])
  const network = declared?.network ?? []
  return (
    <div className="space-y-2">
      {rows.length === 0 && network.length === 0 ? (
        <p className="text-[13px] text-zinc-500">{t('不需要任何特殊权限。')}</p>
      ) : (
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {rows.map((key) => {
            const undeclared = !declared?.[key]
            const text = capabilityText(key)
            return (
              <li key={key} className="flex items-start gap-2.5 px-3 py-2">
                <span
                  aria-hidden="true"
                  className={cx(
                    'mt-1.5 size-1.5 shrink-0 rounded-full',
                    undeclared ? 'bg-amber-500' : key === 'server' ? 'bg-red-500' : 'bg-violet-500',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium">
                    {text.title}
                    {undeclared && (
                      <span className="rounded bg-amber-100 px-1 text-[11px] font-normal text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                        {t('未声明')}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-zinc-500">{text.detail}</p>
                </div>
              </li>
            )
          })}
          {network.length > 0 && (
            <li className="flex items-start gap-2.5 px-3 py-2">
              <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-sky-500" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">{t('访问外部网络')}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {network.map((host) => (
                    <code key={host} className={cx(badgeClass, 'font-mono font-normal')}>
                      {host}
                    </code>
                  ))}
                </div>
                <p className="mt-1 text-xs text-zinc-500">{t('仅为扩展自己的声明，无法强制限制')}</p>
              </div>
            </li>
          )}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          {warnings.map((warning) => (
            <li key={warning}>⚠ {warning}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 启用一个需要确认权限的扩展前弹出 */
export function ApprovalDialog({ extension, onClose }: { extension: ExtensionDTO | null; onClose: () => void }) {
  const { approve, busy } = useApproveExtension()
  return (
    <Dialog
      open={!!extension}
      onClose={onClose}
      title={t('启用「{name}」', { name: extension?.name ?? '' })}
      className="w-[min(520px,calc(100vw-32px))]"
    >
      {extension && (
        <div className="space-y-4">
          <p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
            {t('首次启用或更新后权限有变化，需要你确认以下权限。启用后它的代码会立即运行，只启用你信任的扩展。')}
          </p>
          <PermissionList
            declared={extension.permissions}
            detected={extension.detected}
            warnings={extension.permissionWarnings}
          />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose} disabled={busy}>
              {t('取消')}
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                void approve(extension.id)
                  .then(() => {
                    toast.info(t('已启用「{name}」', { name: extension.name }))
                    onClose()
                  })
                  .catch((e: unknown) => toast.error(errorMessage(e)))
              }
            >
              {busy ? t('启用中…') : t('确认并启用')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}

// ───────────────────────── 安装 ─────────────────────────

/** 从 Git 安装：填地址 → 预览权限 → 确认安装（可同时启用） */
export function InstallDialog({
  open,
  initial,
  onClose,
  onInstalled,
}: {
  open: boolean
  /** 从扩展目录点「安装」时预填 */
  initial?: { url: string; ref?: string | undefined } | undefined
  onClose: () => void
  onInstalled: (extension: ExtensionDTO) => void
}) {
  const git = useGitStatus()
  const flow = useInstallFlow()
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  useEffect(() => {
    if (!open) return
    setUrl(initial?.url ?? '')
    setRef(initial?.ref ?? '')
  }, [open, initial])
  const close = () => {
    if (flow.preview) void flow.cancel()
    onClose()
  }
  const preview = flow.preview
  const noGit = git.data && !git.data.available
  return (
    <Dialog open={open} onClose={close} title={t('从 Git 安装扩展')} className="w-[min(560px,calc(100vw-32px))]">
      {!preview ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (!url.trim() || flow.previewing) return
            flow.start({ url: url.trim(), ref: ref.trim() }).catch((e: unknown) => toast.error(errorMessage(e)))
          }}
        >
          {noGit && (
            <p
              role="alert"
              className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
            >
              {t('服务器上没有找到 git，请先安装 Git 并重启应用。')}
            </p>
          )}
          <Field label={t('仓库地址')} hint={t('支持 https:// 或 git@ 开头的地址')}>
            <input
              className={controlClass}
              value={url}
              autoFocus
              placeholder="https://github.com/user/repo"
              disabled={flow.previewing || noGit}
              onChange={(e) => setUrl(e.target.value)}
            />
          </Field>
          <Field label={t('分支或标签')} hint={t('留空使用默认分支')}>
            <input
              className={controlClass}
              value={ref}
              placeholder="main"
              disabled={flow.previewing || noGit}
              onChange={(e) => setRef(e.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button onClick={close}>{t('取消')}</Button>
            <Button type="submit" variant="primary" disabled={!url.trim() || flow.previewing || noGit}>
              {flow.previewing ? t('正在下载…') : t('下一步')}
            </Button>
          </div>
        </form>
      ) : (
        <InstallPreview
          preview={preview}
          busy={flow.confirming}
          onBack={() => void flow.cancel()}
          onConfirm={(enable) =>
            void flow
              .confirm(enable)
              .then((extension) => {
                toast.info(
                  enable
                    ? t('已安装并启用「{name}」', { name: extension.name })
                    : t('已安装「{name}」', { name: extension.name }),
                )
                onInstalled(extension)
                onClose()
              })
              .catch((e: unknown) => toast.error(errorMessage(e)))
          }
        />
      )}
    </Dialog>
  )
}

function InstallPreview({
  preview,
  busy,
  onBack,
  onConfirm,
}: {
  preview: ExtensionInstallPreview
  busy: boolean
  onBack: () => void
  onConfirm: (enable: boolean) => void
}) {
  const m = preview.manifest
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <h3 className="mr-1 font-semibold break-words">{m.name}</h3>
          <span className={badgeClass}>v{m.version}</span>
          {m.author && <span className={badgeClass}>{m.author}</span>}
          <span className={cx(badgeClass, 'font-mono font-normal')} title={preview.commit}>
            {preview.ref} · {preview.commit.slice(0, 7)}
          </span>
        </div>
        <p className="text-[13px] leading-relaxed whitespace-pre-wrap break-words text-zinc-500">
          {m.description || t('暂无描述。')}
        </p>
      </div>
      {preview.exists && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          {t('已经安装过 id 为「{id}」的扩展，继续会用这个版本替换它。', { id: m.id })}
        </p>
      )}
      <div className="space-y-1.5">
        <h4 className="text-[13px] font-medium">{t('需要的权限')}</h4>
        <PermissionList declared={preview.permissions} detected={preview.detected} warnings={preview.warnings} />
      </div>
      <p className="text-xs leading-relaxed text-zinc-500">
        {t('扩展代码在后端和浏览器中运行，能做任何事，只安装你信任的扩展。')}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onBack} disabled={busy}>
          {t('上一步')}
        </Button>
        <Button onClick={() => onConfirm(false)} disabled={busy}>
          {t('仅安装')}
        </Button>
        <Button variant="primary" onClick={() => onConfirm(true)} disabled={busy}>
          {busy ? t('安装中…') : t('安装并启用')}
        </Button>
      </div>
    </div>
  )
}

// ───────────────────────── Git 信息 ─────────────────────────

/** 详情页里 Git 扩展的来源、版本和更新操作 */
export function GitPanel({
  extension,
  onUninstalled,
  onPermissionsChanged,
}: {
  extension: ExtensionDTO
  onUninstalled: () => void
  /** 更新后权限变多，扩展被停用，交给页面弹出确认 */
  onPermissionsChanged: (extension: ExtensionDTO) => void
}) {
  const git = extension.git
  const ops = useExtensionGit(extension.id)
  const [branches, setBranches] = useState<{ current: string; branches: string[] } | null>(null)
  const fail = (e: unknown) => toast.error(errorMessage(e))
  const uninstall = () => {
    if (!confirm(t('卸载「{name}」？扩展目录、设置和它保存的数据都会被删除。', { name: extension.name }))) return
    ops
      .uninstall()
      .then(() => {
        toast.info(t('已卸载「{name}」', { name: extension.name }))
        onUninstalled()
      })
      .catch(fail)
  }
  if (!git)
    return extension.source === 'local' ? (
      <div className="flex items-center gap-2 text-[13px] text-zinc-500">
        <span className="min-w-0 flex-1">{t('手动放入目录的扩展，不能在这里更新。')}</span>
        <Button size="sm" variant="ghost" disabled={ops.busy} onClick={uninstall}>
          <TrashIcon className="size-3.5" />
          {t('卸载')}
        </Button>
      </div>
    ) : null
  const status =
    git.hasUpdate === null
      ? t('未检查更新')
      : git.hasUpdate
        ? t('有新版本（{commit}）', { commit: git.remoteCommit?.slice(0, 7) ?? '' })
        : t('已是最新')
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="min-w-0 flex-1 space-y-0.5">
        <a
          href={git.url.startsWith('https://') ? git.url : undefined}
          target="_blank"
          rel="noreferrer"
          className="block truncate font-mono text-xs text-zinc-500 hover:text-violet-600"
          title={git.url}
        >
          {git.url}
        </a>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className={cx(badgeClass, 'gap-1 font-mono font-normal')}>
            <BranchIcon className="size-3" />
            {git.ref}
          </span>
          <span className="font-mono text-zinc-400" title={git.commit}>
            {git.commit.slice(0, 7)}
          </span>
          <span className={cx(git.hasUpdate ? 'font-medium text-violet-600 dark:text-violet-400' : 'text-zinc-400')}>
            {status}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {git.hasUpdate ? (
          <Button
            size="sm"
            variant="primary"
            disabled={ops.busy}
            onClick={() =>
              void ops
                .update()
                .then((result) => {
                  if (result.permissionsChanged) onPermissionsChanged(result.extension)
                  else toast.info(t('已更新到 {commit}', { commit: result.extension.git?.commit.slice(0, 7) ?? '' }))
                })
                .catch(fail)
            }
          >
            {t('更新')}
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={ops.busy}
            onClick={() =>
              void ops
                .checkUpdate()
                .then((next) => {
                  if (!next.git?.hasUpdate) toast.info(t('已是最新'))
                })
                .catch(fail)
            }
          >
            <RefreshIcon className={cx('size-3.5', ops.busy && 'animate-spin')} />
            {t('检查更新')}
          </Button>
        )}
        {/* 第一次点开菜单时才拉分支列表（toggle 事件不冒泡，所以在外层捕获点击） */}
        <div
          onPointerDownCapture={() => {
            if (!branches) ops.loadBranches().then(setBranches).catch(fail)
          }}
        >
          <Menu label={t('更多 Git 操作')}>
            <div className="max-h-60 overflow-y-auto">
              {!branches ? (
                <p className="px-3 py-2 text-xs text-zinc-500">{t('加载分支…')}</p>
              ) : (
                branches.branches.map((name) => (
                  <MenuEntry
                    key={name}
                    icon={<BranchIcon />}
                    onClick={() => {
                      if (name === branches.current) return
                      ops
                        .switchRef(name)
                        .then((next) => {
                          setBranches({ ...branches, current: name })
                          if (next.needsApproval) onPermissionsChanged(next)
                          else toast.info(t('已切换到 {ref}', { ref: name }))
                        })
                        .catch(fail)
                    }}
                  >
                    <span className={cx('font-mono', name === branches.current && 'font-semibold text-violet-600')}>
                      {name}
                    </span>
                  </MenuEntry>
                ))
              )}
            </div>
            <MenuDivider />
            <MenuEntry icon={<TrashIcon />} danger onClick={uninstall}>
              {t('卸载')}
            </MenuEntry>
          </Menu>
        </div>
      </div>
    </div>
  )
}

// ───────────────────────── 扩展目录 ─────────────────────────

/** 「扩展目录」列表：所有索引源的扩展合在一起，可搜索 */
export function CatalogList({ onInstall }: { onInstall: (item: ExtensionCatalogItem) => void }) {
  const catalog = useExtensionCatalog(true)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(false)
  const sources = catalog.data?.sources ?? []
  const q = query.trim().toLowerCase()
  const items = sources
    .flatMap((s) => s.items)
    .filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index)
    .filter(
      (item) => !q || [item.name, item.description, item.author, ...item.tags].join(' ').toLowerCase().includes(q),
    )
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            className={cx(inputClass, 'h-8 py-0 pl-8 text-[13px]')}
            placeholder={t('搜索扩展')}
            aria-label={t('搜索扩展')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <IconButton
          label={t('刷新目录')}
          disabled={catalog.isFetching}
          onClick={() => void catalog.refresh().catch((e: unknown) => toast.error(errorMessage(e)))}
        >
          <RefreshIcon className={catalog.isFetching ? 'animate-spin' : ''} />
        </IconButton>
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          {t('索引源')}
        </Button>
      </div>
      {sources
        .filter((s) => !s.ok)
        .map((s) => (
          <p key={s.url} className="truncate px-1 text-xs text-amber-600 dark:text-amber-400" title={s.error}>
            {t('索引拉取失败：{url}', { url: s.url })}
          </p>
        ))}
      {catalog.isPending ? (
        <p className="p-2 text-sm text-zinc-500">{t('加载中…')}</p>
      ) : catalog.error ? (
        <p role="alert" className="p-2 text-sm text-red-600">
          {errorMessage(catalog.error)}
        </p>
      ) : sources.length === 0 ? (
        <div className="space-y-2 p-2 text-[13px] text-zinc-500">
          <p>{t('还没有添加扩展索引。索引是一个列出扩展及其 Git 地址的 JSON 文件，格式见扩展开发文档。')}</p>
          <Button size="sm" onClick={() => setEditing(true)}>
            {t('添加索引源')}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="p-2 text-sm text-zinc-500">{q ? t('没有匹配的扩展') : t('索引里没有扩展')}</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item.id} className="rounded-lg border border-zinc-200 px-2.5 py-2 dark:border-zinc-800">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="mr-0.5 text-sm font-medium break-words">{item.name}</span>
                    {item.version && <span className={badgeClass}>v{item.version}</span>}
                  </div>
                  {item.author && <div className="text-xs text-zinc-400">{item.author}</div>}
                </div>
                {item.installed ? (
                  <span className={cx(badgeClass, 'shrink-0')}>
                    {item.installedVersion ? t('已装 v{version}', { version: item.installedVersion }) : t('已安装')}
                  </span>
                ) : (
                  <IconButton
                    label={t('安装{name}', { name: item.name })}
                    className="shrink-0"
                    onClick={() => onInstall(item)}
                  >
                    <DownloadIcon />
                  </IconButton>
                )}
              </div>
              {item.description && (
                <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-zinc-500">{item.description}</p>
              )}
              {item.tags.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {item.tags.map((tag) => (
                    <span key={tag} className={cx(badgeClass, 'font-normal')}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <SourcesDialog open={editing} onClose={() => setEditing(false)} />
    </div>
  )
}

/** 编辑索引源：一行一个地址 */
function SourcesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sources = useCatalogSources()
  const [text, setText] = useState('')
  useEffect(() => {
    if (open) setText((sources.urls ?? []).join('\n'))
  }, [open, sources.urls])
  const urls = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const invalid = urls.filter((url) => !/^https?:\/\/\S+$/.test(url))
  return (
    <Dialog open={open} onClose={onClose} title={t('扩展索引源')} className="w-[min(560px,calc(100vw-32px))]">
      <div className="space-y-3">
        <p className="text-[13px] leading-relaxed text-zinc-500">
          {t('每行一个索引 JSON 的地址。服务器会拉取这些索引并合并显示；同一个扩展出现在多个索引里时以前面的为准。')}
        </p>
        <textarea
          className={cx(inputClass, 'min-h-32 font-mono text-xs')}
          value={text}
          spellCheck={false}
          placeholder="https://raw.githubusercontent.com/user/repo/main/index.json"
          onChange={(e) => setText(e.target.value)}
        />
        {invalid.length > 0 && (
          <p className="text-xs text-red-600">{t('地址格式不正确：{url}', { url: invalid[0] ?? '' })}</p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('取消')}</Button>
          <Button
            variant="primary"
            disabled={sources.saving || invalid.length > 0}
            onClick={() =>
              void sources
                .save(urls)
                .then(onClose)
                .catch((e: unknown) => toast.error(errorMessage(e)))
            }
          >
            {t('保存')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
