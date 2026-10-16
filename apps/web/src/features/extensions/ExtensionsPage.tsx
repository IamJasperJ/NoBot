import type { ExtensionDTO } from '@ai-parter/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { keys, useExtensions, useTools } from '../../api/queries'
import { Section, Toggle } from '../../components/form'
import { DetailHeader, EmptyDetail, ManagerLayout } from '../../components/layout'
import { Button, cx } from '../../components/ui'
import { loadExtensions } from '../../extensions/runtime'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { SettingsEditor } from './SettingsEditor'

const badgeClass = 'inline-block max-w-full break-all rounded bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800'

function ToolSection() {
  const query = useTools()
  return (
    <Section title="可用工具">
      <p className="text-sm leading-relaxed text-zinc-500">
        工具需要在『生成预设 → 参数 → 推理与工具』里开启『工具调用』才会发送给模型，并且模型本身要支持 function calling
      </p>
      {query.isPending ? (
        <p className="text-sm">加载中…</p>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-red-600">
          {errorMessage(query.error)}
        </p>
      ) : query.data.length === 0 ? (
        <p className="text-sm text-zinc-500">暂无可用工具。启用提供工具的扩展后会显示在这里。</p>
      ) : (
        <div className="space-y-3">
          {query.data.map((tool) => (
            <div
              key={`${tool.source}:${tool.name}`}
              className="min-w-0 space-y-1 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="break-all font-mono text-sm">{tool.name}</span>
                <span className={badgeClass}>来源：{tool.source === 'builtin' ? '内置' : tool.source}</span>
              </div>
              <p className="whitespace-pre-wrap break-words text-sm text-zinc-500">
                {tool.description || '暂无说明。'}
              </p>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

type UpdateExtension = (
  id: string,
  patch: { enabled?: boolean; settings?: Record<string, unknown> },
) => Promise<ExtensionDTO>

function ExtensionDetail({
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
    <>
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
      <div className="space-y-4 p-4 sm:p-6">
        <div className="space-y-2">
          <h2 className="break-words text-lg font-semibold">{extension.name}</h2>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className={badgeClass}>版本：{extension.version}</span>
            <span className={badgeClass}>{extension.source === 'builtin' ? '内置' : '本地'}</span>
            <span className={badgeClass}>{extension.enabled ? '已启用' : '已停用'}</span>
            <span className={badgeClass}>作者：{extension.author || '未提供'}</span>
            {(extension.client.script || extension.client.style) && <span className={badgeClass}>前端</span>}
            {(extension.hasRoutes ||
              Object.values(extension.provides).some((v) => v.length > 0) ||
              (!extension.client.script && !extension.client.style)) && <span className={badgeClass}>后端</span>}
            {dirty && <span className="text-amber-600">有未保存的修改</span>}
          </div>
          <p className="whitespace-pre-wrap break-words text-sm text-zinc-500">
            {extension.description || '暂无描述。'}
          </p>
        </div>
        {extension.loadError && (
          <div
            role="alert"
            className="rounded-lg border border-red-300 bg-red-50 p-3 whitespace-pre-wrap break-words text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
          >
            加载失败：{extension.loadError}
          </div>
        )}
        {extension.hasRoutes && (
          <p className="text-sm">
            自定义接口：<code>/api/ext/{extension.id}/</code>
          </p>
        )}
        <Section title="提供的能力">
          {[
            { label: '宏', values: extension.provides.macros.map((name) => `{{${name}}}`) },
            { label: '工具', values: extension.provides.tools },
            { label: '钩子', values: extension.provides.hooks },
          ]
            .filter((row) => row.values.length > 0)
            .map((row) => (
              <div key={row.label} className="space-y-2">
                <h3 className="text-sm font-medium">{row.label}</h3>
                <div className="flex flex-wrap gap-2">
                  {row.values.map((name) => (
                    <span key={name} className={badgeClass}>
                      {name}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          {Object.values(extension.provides).every((values) => values.length === 0) && (
            <p className="text-sm text-zinc-500">该扩展未声明宏、工具或钩子。</p>
          )}
        </Section>
        <Section title="设置" description="编辑后点击顶部「保存」生效；「撤销修改」会恢复已保存的设置。">
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
        </Section>
        <ToolSection />
      </div>
    </>
  )
}

export function ExtensionsPage() {
  const query = useExtensions()
  const qc = useQueryClient()
  const focusId = useUi((s) => s.focusId)
  const [selectedId, setSelectedId] = useState<string | null>(focusId)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const extension = query.data?.find((item) => item.id === selectedId)

  function select(id: string | null) {
    if (id === selectedId || busy) return
    if (dirty && !confirm('当前扩展有未保存的设置，确定放弃这些修改并切换吗？')) return
    setDirty(false)
    setSelectedId(id)
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
                  className="min-w-[8em] flex-1 truncate text-left text-sm font-medium"
                  title={item.name}
                  onClick={() => select(item.id)}
                >
                  {item.name}
                </button>
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
          {selectedId === null && (
            <div className="mt-4 md:hidden">
              <ToolSection />
            </div>
          )}
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
              <ToolSection />
            </div>
          </>
        )
      }
    />
  )
}
