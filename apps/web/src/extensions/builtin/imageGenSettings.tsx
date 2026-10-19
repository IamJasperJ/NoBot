import type { AttachmentDTO } from '@nobot/shared'
import { useId, useMemo, useState } from 'react'
import { DenseRow, denseSelectClass, TextAreaField } from '../../components/form'
import { EditIcon, PlusIcon, TrashIcon } from '../../components/icons'
import { Button, cx, Dialog, IconButton, inputClass } from '../../components/ui'
import { t } from '../../i18n'
import type { ClientExtensionAPI } from '../types'

/**
 * 图片生成扩展的自定义设置控件（设置表单里 type 为 custom 的字段）。
 * 参照酒馆的 ComfyUI 设置：工作流下拉 + 编辑 / 新建 / 重命名 / 删除，编辑器里显示占位符是否被用到；
 * 风格下拉 + 新建 / 重命名 / 删除，下面直接编辑当前风格。
 */

type Settings = Record<string, unknown>
interface Workflow {
  name: string
  json: string
}
interface Placeholder {
  find: string
  replace: string
}
interface Style {
  name: string
  promptPrefix: string
  promptSuffix: string
  negativePrompt: string
}

const BUILTIN_WORKFLOWS = () => [
  { value: '', label: t('内置默认') },
  { value: 'avatar', label: t('角色头像图生图') },
]

/** 内置占位符，顺序和酒馆一致 */
export const PLACEHOLDERS = [
  'prompt',
  'negative_prompt',
  'model',
  'vae',
  'sampler',
  'scheduler',
  'steps',
  'scale',
  'denoise',
  'clip_skip',
  'width',
  'height',
  'user_avatar',
  'char_avatar',
  'seed',
] as const

const listOf = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

/** 检查工作流 JSON：是否合法（出错时给出行列），以及每个占位符是否被引用（要带双引号，和酒馆一致） */
export function inspectWorkflow(json: string, custom: Placeholder[]) {
  let error: string | undefined
  if (json.trim()) {
    try {
      JSON.parse(json)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const position = Number(message.match(/position (\d+)/)?.[1])
      if (Number.isFinite(position)) {
        const before = json.slice(0, position)
        const line = before.split('\n').length
        const column = position - before.lastIndexOf('\n')
        error = t('JSON 格式错误：第 {line} 行第 {column} 列附近', { line, column })
      } else error = t('JSON 格式错误：{message}', { message })
    }
  }
  const used = (name: string) => json.includes(`"%${name}%"`)
  return {
    error,
    builtin: PLACEHOLDERS.map((name) => ({ name, used: used(name) })),
    custom: custom
      .filter((item) => item.find.trim())
      .map((item) => {
        const name = item.find.trim().replace(/^%|%$/g, '')
        return { name, used: used(name) }
      }),
  }
}

function PlaceholderRow({ name, used }: { name: string; used: boolean }) {
  return (
    <li className="flex items-center gap-2 font-mono text-xs">
      <span
        role="img"
        aria-label={used ? t('已使用') : t('未使用')}
        className={cx(
          'flex size-4 shrink-0 items-center justify-center rounded text-[10px] font-bold text-white',
          used ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600',
        )}
      >
        {used ? '✓' : '–'}
      </span>
      <span className={used ? 'text-zinc-800 dark:text-zinc-200' : 'text-zinc-400'}>"%{name}%"</span>
    </li>
  )
}

/** 工作流编辑器：左边 JSON，右边占位符清单和自定义占位符（照酒馆的 ComfyUI Workflow Editor） */
function WorkflowEditor({
  workflow,
  placeholders,
  onSave,
  onClose,
}: {
  workflow: Workflow
  placeholders: Placeholder[]
  onSave: (json: string, placeholders: Placeholder[]) => void
  onClose: () => void
}) {
  const [json, setJson] = useState(workflow.json)
  const [custom, setCustom] = useState<Placeholder[]>(placeholders)
  const inspection = useMemo(() => inspectWorkflow(json, custom), [json, custom])
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('编辑工作流：{name}', { name: workflow.name })}
      className="w-[min(1100px,calc(100vw-32px))]"
    >
      <div className="flex flex-col gap-4 md:flex-row">
        <div className="min-w-0 flex-1 space-y-1.5">
          <span className="block text-[13px] font-medium">{t('工作流（API 格式 JSON）')}</span>
          <textarea
            aria-label={t('工作流 JSON')}
            spellCheck={false}
            wrap="off"
            className={cx(
              inputClass,
              'h-[55vh] resize-none overflow-auto font-mono text-xs leading-relaxed whitespace-pre',
            )}
            placeholder={t(
              '在 ComfyUI 里用「导出（API）」得到的 JSON 粘贴到这里，{newline}把要替换的值改成占位符，例如 "text": "%prompt%"',
              { newline: '\n' },
            )}
            value={json}
            onChange={(e) => setJson(e.target.value)}
          />
          {inspection.error ? (
            <p className="text-xs text-red-600">{inspection.error}</p>
          ) : (
            <p className="text-xs text-zinc-500">{t('占位符要带双引号，数字也一样，例如 "steps": "%steps%"')}</p>
          )}
        </div>
        <aside className="w-full shrink-0 space-y-3 md:w-60">
          <div>
            <h3 className="mb-2 text-[13px] font-medium">{t('占位符')}</h3>
            <ul className="space-y-1">
              {inspection.builtin.map((item) => (
                <PlaceholderRow key={item.name} {...item} />
              ))}
            </ul>
          </div>
          <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
            <h3 className="mb-2 text-[13px] font-medium">{t('自定义占位符')}</h3>
            <div className="space-y-2">
              {custom.map((item, index) => {
                const status = inspection.custom.find((c) => c.name === item.find.trim().replace(/^%|%$/g, ''))
                return (
                  <div key={index} className="flex items-center gap-1.5">
                    <span
                      className={cx(
                        'size-2 shrink-0 rounded-full',
                        status?.used ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600',
                      )}
                      title={status?.used ? t('已使用') : t('未使用')}
                    />
                    <input
                      aria-label={t('查找')}
                      placeholder={t('名称')}
                      className={cx(inputClass, 'h-8 w-20 px-2 py-0 font-mono text-xs')}
                      value={item.find}
                      onChange={(e) =>
                        setCustom(custom.map((c, i) => (i === index ? { ...c, find: e.target.value } : c)))
                      }
                    />
                    <input
                      aria-label={t('替换')}
                      placeholder={t('替换为（支持 {{char}}）')}
                      className={cx(inputClass, 'h-8 min-w-0 flex-1 px-2 py-0 text-xs')}
                      value={item.replace}
                      onChange={(e) =>
                        setCustom(custom.map((c, i) => (i === index ? { ...c, replace: e.target.value } : c)))
                      }
                    />
                    <IconButton
                      variant="danger"
                      label={t('删除占位符')}
                      onClick={() => setCustom(custom.filter((_, i) => i !== index))}
                    >
                      <TrashIcon />
                    </IconButton>
                  </div>
                )
              })}
              <Button size="sm" variant="ghost" onClick={() => setCustom([...custom, { find: '', replace: '' }])}>
                <PlusIcon />
                {t('添加')}
              </Button>
            </div>
          </div>
        </aside>
      </div>
      <div className="mt-5 flex items-center justify-end gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
        <span className="mr-auto text-xs text-zinc-500">{t('确定后还要点右上角「保存」才会写入设置')}</span>
        <Button onClick={onClose}>{t('取消')}</Button>
        <Button variant="primary" disabled={!!inspection.error} onClick={() => onSave(json, custom)}>
          {t('确定')}
        </Button>
      </div>
    </Dialog>
  )
}

function CodeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="m8 7-5 5 5 5M16 7l5 5-5 5" />
    </svg>
  )
}

/** 工作流：下拉选择 + 编辑 / 新建 / 重命名 / 删除 */
export function WorkflowField({
  settings,
  onSettingsChange,
  disabled,
  hint,
}: {
  settings: Settings
  onSettingsChange: (settings: Settings) => void
  disabled: boolean
  hint?: string | undefined
}) {
  const id = useId()
  const workflows = listOf<Workflow>(settings.comfyWorkflows)
  const placeholders = listOf<Placeholder>(settings.comfyCustomPlaceholders)
  const current = typeof settings.comfyWorkflowName === 'string' ? settings.comfyWorkflowName : ''
  const custom = workflows.find((w) => w.name === current)
  const builtin = BUILTIN_WORKFLOWS().some((w) => w.value === current)
  const [editing, setEditing] = useState<Workflow | null>(null)
  const update = (patch: Settings) => onSettingsChange({ ...settings, ...patch })
  const askName = (initial: string) => {
    const name = prompt(t('工作流名称'), initial)?.trim()
    if (!name) return null
    if (workflows.some((w) => w.name === name) || BUILTIN_WORKFLOWS().some((w) => w.label === name)) {
      alert(t('已经有名为「{name}」的工作流', { name }))
      return null
    }
    return name
  }
  const inspection = custom ? inspectWorkflow(custom.json, placeholders) : null
  return (
    <div>
      <DenseRow id={id} label={t('工作流')} hint={hint} disabled={disabled}>
        <select
          id={id}
          className={cx(denseSelectClass, 'min-w-0 flex-1')}
          value={current}
          disabled={disabled}
          onChange={(e) => update({ comfyWorkflowName: e.target.value })}
        >
          {BUILTIN_WORKFLOWS().map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
          {workflows.length > 0 && (
            <optgroup label={t('自定义')}>
              {workflows.map((w) => (
                <option key={w.name} value={w.name}>
                  {w.name}
                </option>
              ))}
            </optgroup>
          )}
          {!builtin && !custom && <option value={current}>{t('{name}（不存在）', { name: current })}</option>}
        </select>
        <IconButton
          variant="outline"
          className="size-8"
          label={builtin ? t('内置工作流不能编辑，可以新建一个自定义工作流') : t('编辑工作流')}
          disabled={disabled || !custom}
          onClick={() => custom && setEditing(custom)}
        >
          <CodeIcon />
        </IconButton>
        <IconButton
          variant="outline"
          className="size-8"
          label={t('新建工作流')}
          disabled={disabled}
          onClick={() => {
            const name = askName('')
            if (!name) return
            const created = { name, json: '' }
            update({ comfyWorkflows: [...workflows, created], comfyWorkflowName: name })
            setEditing(created)
          }}
        >
          <PlusIcon />
        </IconButton>
        <IconButton
          variant="outline"
          className="size-8"
          label={t('重命名工作流')}
          disabled={disabled || !custom}
          onClick={() => {
            if (!custom) return
            const name = askName(custom.name)
            if (!name) return
            update({
              comfyWorkflows: workflows.map((w) => (w.name === custom.name ? { ...w, name } : w)),
              comfyWorkflowName: name,
            })
          }}
        >
          <EditIcon />
        </IconButton>
        <IconButton
          variant="outline"
          className="size-8"
          label={t('删除工作流')}
          disabled={disabled || !custom}
          onClick={() => {
            if (!custom || !confirm(t('删除工作流「{name}」？', { name: custom.name }))) return
            update({ comfyWorkflows: workflows.filter((w) => w.name !== custom.name), comfyWorkflowName: '' })
          }}
        >
          <TrashIcon />
        </IconButton>
      </DenseRow>
      {inspection && (
        <p className="pb-1 pl-38 text-xs text-zinc-500">
          {inspection.error ? (
            <span className="text-red-600">{inspection.error}</span>
          ) : custom?.json.trim() ? (
            <>
              {t('用到的占位符：')}
              <span className="font-mono">
                {inspection.builtin
                  .filter((p) => p.used)
                  .map((p) => p.name)
                  .join('、') || t('无')}
              </span>
            </>
          ) : (
            <span className="text-amber-600">{t('这个工作流还是空的，点左边的编辑按钮粘贴 JSON')}</span>
          )}
        </p>
      )}
      {editing && (
        <WorkflowEditor
          workflow={editing}
          placeholders={placeholders}
          onClose={() => setEditing(null)}
          onSave={(json, nextPlaceholders) => {
            update({
              comfyWorkflows: listOf<Workflow>(settings.comfyWorkflows).map((w) =>
                w.name === editing.name ? { ...w, json } : w,
              ),
              comfyCustomPlaceholders: nextPlaceholders,
            })
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

/** 风格：下拉选择 + 新建 / 重命名 / 删除，下面直接编辑当前风格（照酒馆的 Style） */
export function StyleField({
  settings,
  onSettingsChange,
  disabled,
  hint,
}: {
  settings: Settings
  onSettingsChange: (settings: Settings) => void
  disabled: boolean
  hint?: string | undefined
}) {
  const id = useId()
  const styles = listOf<Style>(settings.styles)
  const active = typeof settings.activeStyle === 'string' ? settings.activeStyle : ''
  const index = Math.max(
    0,
    styles.findIndex((s) => s.name === active),
  )
  const style = styles[index]
  const update = (patch: Settings) => onSettingsChange({ ...settings, ...patch })
  const editStyle = (patch: Partial<Style>) =>
    update({ styles: styles.map((s, i) => (i === index ? { ...s, ...patch } : s)) })
  const askName = (initial: string) => {
    const name = prompt(t('风格名称'), initial)?.trim()
    if (!name) return null
    if (styles.some((s) => s.name === name)) {
      alert(t('已经有名为「{name}」的风格', { name }))
      return null
    }
    return name
  }
  return (
    <div className="space-y-1">
      <DenseRow id={id} label={t('风格')} hint={hint} disabled={disabled}>
        <select
          id={id}
          className={cx(denseSelectClass, 'min-w-0 flex-1')}
          value={style?.name ?? ''}
          disabled={disabled || !styles.length}
          onChange={(e) => update({ activeStyle: e.target.value })}
        >
          {styles.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
          {!styles.length && <option value="">{t('（还没有风格）')}</option>}
        </select>
        <IconButton
          variant="outline"
          className="size-8"
          label={t('以当前内容新建风格')}
          disabled={disabled}
          onClick={() => {
            const name = askName(style ? t('{name} 副本', { name: style.name }) : t('新风格'))
            if (!name) return
            const created: Style = {
              name,
              promptPrefix: style?.promptPrefix ?? '',
              promptSuffix: style?.promptSuffix ?? '',
              negativePrompt: style?.negativePrompt ?? '',
            }
            update({ styles: [...styles, created], activeStyle: name })
          }}
        >
          <PlusIcon />
        </IconButton>
        <IconButton
          variant="outline"
          className="size-8"
          label={t('重命名风格')}
          disabled={disabled || !style}
          onClick={() => {
            if (!style) return
            const name = askName(style.name)
            if (name) update({ styles: styles.map((s, i) => (i === index ? { ...s, name } : s)), activeStyle: name })
          }}
        >
          <EditIcon />
        </IconButton>
        <IconButton
          variant="outline"
          className="size-8"
          label={t('删除风格')}
          disabled={disabled || !style || styles.length <= 1}
          onClick={() => {
            if (!style || !confirm(t('删除风格「{name}」？', { name: style.name }))) return
            const rest = styles.filter((_, i) => i !== index)
            update({ styles: rest, activeStyle: rest[0]?.name ?? '' })
          }}
        >
          <TrashIcon />
        </IconButton>
      </DenseRow>
      {style && (
        <>
          <TextAreaField
            label={t('正向前缀')}
            hint={t('每次生成都加在最前面，常用于画风和质量词；可以写 {prompt} 指定生成提示词的插入位置')}
            rows={3}
            mono
            disabled={disabled}
            value={style.promptPrefix}
            onChange={(promptPrefix) => editStyle({ promptPrefix })}
          />
          <TextAreaField
            label={t('负面提示词')}
            rows={4}
            mono
            disabled={disabled}
            value={style.negativePrompt}
            onChange={(negativePrompt) => editStyle({ negativePrompt })}
          />
          <TextAreaField
            label={t('正向后缀')}
            hint={t('加在生成提示词之后')}
            rows={2}
            mono
            disabled={disabled}
            value={style.promptSuffix}
            onChange={(promptSuffix) => editStyle({ promptSuffix })}
          />
        </>
      )}
    </div>
  )
}

/** 用表单草稿调用测试接口（不保存设置）。返回接口的 JSON，失败时抛出带中文信息的错误 */
export async function postDraft(
  api: Pick<ClientExtensionAPI, 'fetchServer'>,
  path: 'test' | 'test-connection',
  settings: Settings,
) {
  const response = await api.fetchServer(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  })
  const raw = await response.text()
  let data: { error?: { message?: string }; image?: AttachmentDTO; durationMs?: number } = {}
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {
    throw new Error(t('HTTP {status}：返回的不是 JSON', { status: response.status }))
  }
  if (!response.ok) throw new Error(data.error?.message ?? `HTTP ${response.status}`)
  return data
}

/** 设置页底部：测试连接 / 测试生成 */
export function SettingsFooter({ api, settings }: { api: ClientExtensionAPI; settings: Settings }) {
  const [busy, setBusy] = useState<'connect' | 'test' | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string; image?: AttachmentDTO } | null>(null)
  const call = async (path: 'test-connection' | 'test') => {
    setBusy(path === 'test' ? 'test' : 'connect')
    setResult(null)
    try {
      const data = await postDraft(api, path, settings)
      setResult(
        path === 'test'
          ? {
              ok: true,
              text: t('生成成功，用时 {seconds} 秒', { seconds: ((data.durationMs ?? 0) / 1000).toFixed(1) }),
              ...(data.image ? { image: data.image } : {}),
            }
          : { ok: true, text: t('连接成功') },
      )
    } catch (error) {
      setResult({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto text-sm font-semibold">{t('测试')}</span>
        <Button size="sm" disabled={!!busy} onClick={() => void call('test-connection')}>
          {busy === 'connect' ? t('连接中…') : t('测试连接')}
        </Button>
        <Button size="sm" variant="primary" disabled={!!busy} onClick={() => void call('test')}>
          {busy === 'test' ? t('生成中…') : t('测试生成')}
        </Button>
      </div>
      <p className="text-xs text-zinc-500">{t('使用当前表单里的设置（未保存的修改也会生效），不会插入任何会话')}</p>
      {result && (
        <div className={cx('text-sm', result.ok ? 'text-emerald-600' : 'text-red-600')}>
          {result.text}
          {result.image && (
            <img
              src={result.image.url}
              alt={t('测试生成的图片')}
              className="mt-2 max-h-48 rounded-lg ring-1 ring-black/5"
            />
          )}
        </div>
      )}
    </div>
  )
}
