import type { ApiPresetDTO, ApiPresetInput } from '@ai-parter/shared'
import { useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useEffect, useState } from 'react'
import { api } from '../../api/client'
import { keys, useApiPresets, usePersonas } from '../../api/queries'
import { Button, cx, Dialog, Field, inputClass } from '../../components/ui'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'

/** 表单里的值都先当字符串处理，保存时再转数字 */
interface FormState {
  name: string
  baseUrl: string
  apiKey: string
  model: string
  contextSize: string
  maxTokens: string
  temperature: string
}

const emptyForm: FormState = {
  name: '',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  contextSize: '16384',
  maxTokens: '1024',
  temperature: '',
}

function toForm(p: ApiPresetDTO): FormState {
  return {
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: '',
    model: p.model,
    contextSize: String(p.contextSize),
    maxTokens: String(p.params.max_tokens),
    temperature: p.params.temperature === undefined ? '' : String(p.params.temperature),
  }
}

function toInput(f: FormState, original?: ApiPresetDTO): ApiPresetInput {
  return {
    name: f.name,
    baseUrl: f.baseUrl.trim(),
    // Key 留空表示不修改
    ...(f.apiKey ? { apiKey: f.apiKey } : {}),
    model: f.model,
    contextSize: Number(f.contextSize),
    params: {
      ...original?.params,
      max_tokens: Number(f.maxTokens),
      temperature: f.temperature === '' ? undefined : Number(f.temperature),
    },
  }
}

function ApiPresetsPanel() {
  const qc = useQueryClient()
  const presets = useApiPresets()
  const [selected, setSelected] = useState<string | 'new'>('new')
  const [form, setForm] = useState<FormState>(emptyForm)
  const [models, setModels] = useState<string[]>([])
  const [testing, setTesting] = useState(false)
  const current = presets.data?.find((p) => p.id === selected)

  // 有预设时默认选中第一个
  useEffect(() => {
    if (selected === 'new' && presets.data?.[0] && form === emptyForm) {
      setSelected(presets.data[0].id)
      setForm(toForm(presets.data[0]))
    }
  }, [presets.data, selected, form])

  const pick = (p: ApiPresetDTO | null) => {
    setSelected(p?.id ?? 'new')
    setForm(p ? toForm(p) : emptyForm)
    setModels([])
  }

  const set = (key: keyof FormState) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))

  const refresh = () => qc.invalidateQueries({ queryKey: keys.apiPresets })

  const save = async (e: FormEvent) => {
    e.preventDefault()
    try {
      const saved =
        selected === 'new'
          ? await api.createApiPreset(toInput(form))
          : await api.updateApiPreset(selected, toInput(form, current))
      await refresh()
      pick(saved)
      toast.info('已保存')
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  const test = async () => {
    setTesting(true)
    try {
      const r = await api.testConnection({
        baseUrl: form.baseUrl.trim(),
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
        ...(selected !== 'new' ? { presetId: selected } : {}),
      })
      if (r.ok) {
        setModels(r.models)
        toast.info(`连接成功，共 ${r.models.length} 个模型`)
      } else toast.error(r.error ?? '连接失败')
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setTesting(false)
    }
  }

  const remove = async () => {
    if (!current || !confirm(`删除预设「${current.name}」？`)) return
    await api.deleteApiPreset(current.id).catch((err) => toast.error(errorMessage(err)))
    await refresh()
    pick(null)
  }

  const makeDefault = async () => {
    if (!current) return
    await api.setDefaultApiPreset(current.id).catch((err) => toast.error(errorMessage(err)))
    await refresh()
  }

  return (
    <div className="flex flex-col gap-4 sm:flex-row">
      <div className="flex shrink-0 gap-1 overflow-x-auto sm:w-40 sm:flex-col">
        {presets.data?.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => pick(p)}
            className={cx(
              'shrink-0 truncate rounded-lg px-3 py-2 text-left text-sm',
              p.id === selected ? 'bg-violet-100 dark:bg-violet-950' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
            )}
          >
            {p.name}
            {p.isDefault && <span className="ml-1 text-xs text-violet-600 dark:text-violet-400">默认</span>}
          </button>
        ))}
        <button
          type="button"
          onClick={() => pick(null)}
          className={cx(
            'shrink-0 rounded-lg px-3 py-2 text-left text-sm text-violet-600 dark:text-violet-400',
            selected === 'new' ? 'bg-violet-100 dark:bg-violet-950' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
          )}
        >
          + 新建预设
        </button>
      </div>

      <form onSubmit={save} className="min-w-0 flex-1 space-y-3">
        <Field label="名称">
          <input
            className={inputClass}
            value={form.name}
            onChange={set('name')}
            required
            placeholder="比如：DeepSeek"
          />
        </Field>
        <Field label="接口地址" hint="OpenAI 兼容接口，一般以 /v1 结尾">
          <input className={inputClass} value={form.baseUrl} onChange={set('baseUrl')} required />
        </Field>
        <Field
          label="API Key"
          hint={current?.apiKeyMasked ? `已保存：${current.apiKeyMasked}，留空则不修改` : undefined}
        >
          <input
            className={inputClass}
            type="password"
            value={form.apiKey}
            onChange={set('apiKey')}
            autoComplete="off"
          />
        </Field>
        <Field label="模型">
          <div className="flex gap-2">
            <input className={inputClass} value={form.model} onChange={set('model')} list="model-list" required />
            <Button onClick={test} disabled={testing} className="shrink-0">
              {testing ? '测试中…' : '测试并获取模型'}
            </Button>
          </div>
          <datalist id="model-list">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="上下文长度">
            <input
              className={inputClass}
              type="number"
              min={512}
              value={form.contextSize}
              onChange={set('contextSize')}
            />
          </Field>
          <Field label="回复长度上限">
            <input className={inputClass} type="number" min={1} value={form.maxTokens} onChange={set('maxTokens')} />
          </Field>
          <Field label="温度">
            <input
              className={inputClass}
              type="number"
              step={0.05}
              min={0}
              max={2}
              value={form.temperature}
              onChange={set('temperature')}
              placeholder="默认"
            />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2 pt-2">
          <Button type="submit" variant="primary">
            保存
          </Button>
          {current && !current.isDefault && <Button onClick={makeDefault}>设为默认</Button>}
          {current && (
            <Button variant="danger" onClick={remove} className="ml-auto">
              删除
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}

function PersonaPanel() {
  const qc = useQueryClient()
  const personas = usePersonas()
  const persona = personas.data?.find((p) => p.isDefault) ?? personas.data?.[0]
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  useEffect(() => {
    if (persona) {
      setName(persona.name)
      setDescription(persona.description)
    }
  }, [persona])

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!persona) return
    try {
      await api.updatePersona(persona.id, { name, description })
      await qc.invalidateQueries({ queryKey: keys.personas })
      toast.info('已保存')
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <form onSubmit={save} className="space-y-3">
      <Field label="你的名字" hint="角色卡里的 {{user}} 会替换成这个名字">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
      </Field>
      <Field label="关于你" hint="会作为「用户人设」放进 Prompt，可以留空">
        <textarea
          className={`${inputClass} min-h-28`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <Button type="submit" variant="primary">
        保存
      </Button>
    </form>
  )
}

export function SettingsDialog() {
  const { settingsOpen, setSettingsOpen } = useUi()
  const [tab, setTab] = useState<'api' | 'persona'>('api')
  const tabs = [
    { id: 'api', label: '模型接口' },
    { id: 'persona', label: '我的人设' },
  ] as const

  return (
    <Dialog open={settingsOpen} onClose={() => setSettingsOpen(false)} title="设置">
      <div className="mb-4 flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cx(
              'flex-1 rounded-md py-1.5 text-sm font-medium',
              tab === t.id ? 'bg-white shadow-sm dark:bg-zinc-950' : 'text-zinc-500',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'api' ? <ApiPresetsPanel /> : <PersonaPanel />}
    </Dialog>
  )
}
