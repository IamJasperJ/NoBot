import { type ApiPresetDTO, PROVIDERS, type ProviderInfo, providerInfo, providerOptions } from '@nobot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useEffectEvent, useState } from 'react'
import { api } from '../../api/client'
import { keys, useConnections } from '../../api/queries'
import { Combobox } from '../../components/combobox'
import { SelectField, Tabs, TextField } from '../../components/form'
import { HeadersEditor } from '../../components/headers'
import { CheckIcon, RefreshIcon, TrashIcon } from '../../components/icons'
import { DetailHeader, ListItem, ManagerLayout } from '../../components/layout'
import { Menu, MenuEntry } from '../../components/menu'
import { Button, Field, IconButton, selectClass } from '../../components/ui'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { ProfilesManager } from './ProfilesManager'

interface Draft {
  name: string
  provider: string
  options: Record<string, string>
  baseUrl: string
  apiKey: string
  headers: Record<string, string>
  model: string
  vision: ApiPresetDTO['vision']
}
const emptyDraft = (): Draft => ({
  name: '',
  provider: 'openai',
  options: providerOptions('openai'),
  baseUrl: providerInfo('openai').baseUrls[0]?.url ?? '',
  apiKey: '',
  model: '',
  headers: {},
  vision: 'auto',
})
const toDraft = (p: ApiPresetDTO): Draft => ({
  name: p.name,
  provider: p.provider,
  options: p.options ?? {},
  baseUrl: p.baseUrl,
  apiKey: '',
  model: p.model,
  headers: p.headers ?? {},
  vision: p.vision,
})

/** 「连接」页：上面切换「连接」和「配置组」两个列表 */
export function ConnectionsPage() {
  const [tab, setTab] = useState<'connections' | 'profiles'>('connections')
  const tabs = (
    <div className="mb-2 px-1">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'connections', label: t('连接') },
          { id: 'profiles', label: t('配置组') },
        ]}
      />
    </div>
  )
  return tab === 'connections' ? <ConnectionsManager tabs={tabs} /> : <ProfilesManager tabs={tabs} />
}

function ConnectionsManager({ tabs }: { tabs: ReactNode }) {
  const query = useConnections()
  const qc = useQueryClient()
  const focusId = useUi((s) => s.focusId)
  const [original, setOriginal] = useState<ApiPresetDTO | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const baseline = original ? toDraft(original) : emptyDraft()
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(baseline)
  const canLeave = () => !dirty || confirm(t('此连接有未保存的修改，是否放弃？'))
  const pick = (p: ApiPresetDTO | null, create = false) => {
    setOriginal(p ? { ...p } : null)
    setDraft(p ? toDraft(p) : create ? emptyDraft() : null)
    setModels([])
  }
  const handleFocus = useEffectEvent((id: string) => {
    const p = query.data?.find((item) => item.id === id)
    if (!p || busy || testing) return
    if (p.id !== original?.id && canLeave()) pick(p)
    useUi.getState().openView('connections')
  })
  useEffect(() => {
    if (focusId && query.data && !busy && !testing) handleFocus(focusId)
  }, [focusId, query.data, busy, testing])
  const refresh = () => qc.invalidateQueries({ queryKey: keys.connections })
  const run = async (action: () => Promise<void>) => {
    if (busy || testing) return
    setBusy(true)
    try {
      await action()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const test = async () => {
    if (!draft || busy || testing) return
    setTesting(true)
    setModels([])
    try {
      const result = await api.testConnection({
        provider: draft.provider,
        options: draft.options,
        baseUrl: draft.baseUrl.trim(),
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        headers: draft.headers,
        ...(original ? { presetId: original.id } : {}),
      })
      if (result.ok) {
        setModels([...new Set(result.models)])
        toast.info(t('连接成功，共 {count} 个模型', { count: result.models.length }))
      } else toast.error(result.error || t('连接失败'))
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setTesting(false)
    }
  }
  const current = query.data?.find((p) => p.id === original?.id) ?? original
  const locked = busy || testing
  const info = providerInfo(draft?.provider)
  return (
    <ManagerLayout
      detailIn="panel"
      title={t('连接')}
      showDetailOnMobile={!!draft}
      actions={
        <Button
          disabled={locked}
          onClick={() => {
            if (canLeave()) pick(null, true)
          }}
        >
          {t('新建')}
        </Button>
      }
      list={
        <>
          {tabs}
          {query.isPending && <p className="p-3 text-sm text-zinc-500">{t('加载中…')}</p>}
          {query.isError && (
            <p role="alert" className="p-3 text-sm text-red-600">
              {errorMessage(query.error)}
            </p>
          )}
          {query.data?.length === 0 && (
            <p className="p-3 text-sm text-zinc-500">{t('还没有连接，点击「新建」填写接口和模型。')}</p>
          )}
          {query.data?.map((p) => (
            <ListItem
              key={p.id}
              active={p.id === original?.id}
              onClick={() => {
                if (!locked && p.id !== original?.id && canLeave()) pick(p)
              }}
            >
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <span className="shrink-0 truncate text-xs text-zinc-400">{providerLabel(providerInfo(p.provider))}</span>
              {p.isDefault && (
                <span className="shrink-0 rounded bg-violet-100 px-1.5 text-xs text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                  {t('默认')}
                </span>
              )}
            </ListItem>
          ))}
        </>
      }
      detail={
        draft ? (
          <>
            <DetailHeader
              title={original ? draft.name || t('未命名连接') : t('新建连接')}
              onBack={() => {
                if (!locked && canLeave()) pick(null)
              }}
            />
            <form
              className="p-3"
              onSubmit={(event) => {
                event.preventDefault()
                if (!dirty || locked) return
                void run(async () => {
                  const input = {
                    name: draft.name.trim(),
                    provider: draft.provider,
                    options: draft.options,
                    baseUrl: draft.baseUrl.trim(),
                    model: draft.model.trim(),
                    headers: draft.headers,
                    vision: draft.vision,
                    ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
                  }
                  const saved = original
                    ? await api.updateConnection(original.id, input)
                    : await api.createConnection(input)
                  pick(saved)
                  await refresh()
                  toast.info(t('已保存连接'))
                })
              }}
            >
              <fieldset disabled={locked} className="min-w-0 space-y-5">
                <div className="flex items-center gap-1.5">
                  <Button
                    type="submit"
                    size="sm"
                    variant="primary"
                    disabled={
                      locked ||
                      !dirty ||
                      !draft.name.trim() ||
                      !draft.baseUrl.trim() ||
                      !draft.model.trim() ||
                      (info.options ?? []).some((o) => o.required && !draft.options[o.key]?.trim())
                    }
                  >
                    {t('保存')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={locked || !dirty}
                    onClick={() => {
                      setDraft(baseline)
                      setModels([])
                    }}
                  >
                    {t('撤销修改')}
                  </Button>
                  {original && (
                    <div className="ml-auto">
                      <Menu>
                        {!current?.isDefault && (
                          <MenuEntry
                            icon={<CheckIcon />}
                            onClick={() =>
                              void run(async () => {
                                await api.setDefaultConnection(original.id)
                                await refresh()
                                toast.info(t('已设为默认连接'))
                              })
                            }
                          >
                            {t('设为默认')}
                          </MenuEntry>
                        )}
                        <MenuEntry
                          icon={<TrashIcon />}
                          danger
                          onClick={() => {
                            if (
                              confirm(
                                t('删除连接「{name}」？已保存的接口地址、密钥和模型配置及未保存的修改都会被删除。', {
                                  name: original.name,
                                }),
                              )
                            )
                              void run(async () => {
                                await api.deleteConnection(original.id)
                                pick(null)
                                await refresh()
                              })
                          }}
                        >
                          {t('删除')}
                        </MenuEntry>
                      </Menu>
                    </div>
                  )}
                </div>
                <TextField
                  label={t('名称')}
                  hint={t('为此连接起一个便于辨认的名字，例如服务商和用途。')}
                  value={draft.name}
                  onChange={(name) => setDraft({ ...draft, name })}
                />
                <ProviderSelect
                  value={draft.provider}
                  disabled={locked}
                  onChange={(provider) => {
                    const next = providerInfo(provider)
                    // 地址为空或还是上一个提供方的预设地址时，换成新提供方的默认地址；用户手填过的地址保留
                    const presets = providerInfo(draft.provider).baseUrls.map((u) => u.url)
                    const keepUrl = draft.baseUrl.trim() && !presets.includes(draft.baseUrl.trim())
                    setDraft({
                      ...draft,
                      provider,
                      options: providerOptions(provider),
                      baseUrl: keepUrl ? draft.baseUrl : (next.baseUrls[0]?.url ?? ''),
                    })
                    setModels([])
                  }}
                />
                <Field label={t('接口地址')} hint={baseUrlHint(info)}>
                  <Combobox
                    label={t('接口地址')}
                    value={draft.baseUrl}
                    options={info.baseUrls.map((u) => ({ value: u.url, label: u.label ? pt(u.label) : u.url }))}
                    disabled={locked}
                    placeholder={info.protocol === 'azure' ? 'https://<resource>.openai.azure.com' : 'https://…/v1'}
                    onChange={(baseUrl) => {
                      setDraft({ ...draft, baseUrl })
                      setModels([])
                    }}
                  />
                </Field>
                {(info.options ?? [])
                  .filter((o) => !o.when || (draft.options[o.when.key] ?? '') === o.when.equals)
                  .map((o) =>
                    o.type === 'select' ? (
                      <SelectField
                        key={o.key}
                        label={pt(o.label)}
                        hint={o.hint ? pt(o.hint) : undefined}
                        value={draft.options[o.key] ?? o.default ?? ''}
                        options={(o.choices ?? []).map((c) => ({ value: c.value, label: pt(c.label) }))}
                        onChange={(value) => setDraft({ ...draft, options: { ...draft.options, [o.key]: value } })}
                      />
                    ) : (
                      <TextField
                        key={o.key}
                        label={o.required ? `${pt(o.label)} *` : pt(o.label)}
                        hint={o.hint ? pt(o.hint) : undefined}
                        placeholder={o.placeholder}
                        value={draft.options[o.key] ?? ''}
                        onChange={(value) => setDraft({ ...draft, options: { ...draft.options, [o.key]: value } })}
                      />
                    ),
                  )}
                <TextField
                  label={
                    info.protocol === 'vertex' && draft.options.authMode === 'service_account'
                      ? t('服务账号 JSON')
                      : 'API Key'
                  }
                  hint={
                    original
                      ? t('已保存：{maskedKey}；留空则不修改。', {
                          maskedKey: original.apiKeyMasked || t('未设置密钥'),
                        })
                      : info.keyHint
                        ? pt(info.keyHint)
                        : info.keyRequired
                          ? t('填写服务商提供的 API Key。')
                          : t('填写服务商提供的 API Key；无需密钥的本地接口可以留空。')
                  }
                  type="password"
                  value={draft.apiKey}
                  onChange={(apiKey) => {
                    setDraft({ ...draft, apiKey })
                    setModels([])
                  }}
                />
                <Field
                  label={t('模型')}
                  hint={
                    info.protocol === 'azure'
                      ? t('填部署对应的模型名，仅用于显示和判断能力；实际请求按上面的部署名发送')
                      : t(
                          '可以从接口拉取全部模型后选择，也可以直接手填任意模型 ID；拉取使用当前表单的地址、密钥和请求头',
                        )
                  }
                >
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <Combobox
                        label={t('模型')}
                        value={draft.model}
                        options={[...new Set([...(info.staticModels ?? []), ...models])].map((model) => ({
                          value: model,
                          label: model,
                        }))}
                        disabled={locked}
                        placeholder={t('直接输入，或点右侧按钮拉取')}
                        onChange={(model) => setDraft({ ...draft, model })}
                      />
                    </div>
                    <IconButton
                      variant="outline"
                      label={testing ? t('测试中…') : t('测试连接并拉取模型')}
                      disabled={locked || !draft.baseUrl.trim()}
                      onClick={() => void test()}
                    >
                      <RefreshIcon className={testing ? 'animate-spin' : ''} />
                    </IconButton>
                  </div>
                </Field>
                <SelectField
                  label={t('支持看图')}
                  hint={t(
                    '不支持时，消息里的图片会换成「图片说明」扩展生成的文字描述。自动：按模型名判断（GPT-4o、Claude 3 以上、Gemini、Qwen-VL 等算支持）',
                  )}
                  value={draft.vision}
                  onChange={(vision) => setDraft({ ...draft, vision })}
                  options={[
                    { value: 'auto', label: t('自动判断') },
                    { value: 'yes', label: t('支持') },
                    { value: 'no', label: t('不支持') },
                  ]}
                />
                <div className="space-y-1.5">
                  <span className="block text-[13px] font-medium text-zinc-800 dark:text-zinc-200">
                    {t('额外请求头')}
                  </span>
                  <p className="text-xs leading-relaxed text-zinc-500">
                    {t('发往这个连接的每个请求都会带上（聊天、拉取模型、图片生成复用连接时），例如反向代理鉴权')}
                  </p>
                  <HeadersEditor
                    key={original?.id ?? 'new'}
                    value={draft.headers}
                    disabled={locked}
                    onChange={(headers) => setDraft({ ...draft, headers })}
                  />
                </div>
              </fieldset>
            </form>
          </>
        ) : null
      }
    />
  )
}

/** 品牌名不翻译，只有「自定义」这类中文名需要 t() */
function providerLabel(info: ProviderInfo) {
  return info.group === 'custom' ? pt(info.label) : info.label
}

function baseUrlHint(info: ProviderInfo) {
  if (info.protocol === 'azure') return t('Azure 资源的地址，不含 /openai 部分')
  if (info.protocol === 'anthropic' || info.protocol === 'google' || info.protocol === 'vertex')
    return t('一般不用改；走反向代理时换成代理地址')
  if (info.baseUrls.length > 1) return t('点右侧箭头切换站点，也可以直接改成代理地址')
  return t('OpenAI 兼容接口，一般以 /v1 结尾')
}

const groups: { id: ProviderInfo['group']; label: string }[] = [
  { id: 'cloud', label: '云端服务' },
  { id: 'local', label: '本地 / 自部署' },
  { id: 'custom', label: '其他' },
]

/** 提供方下拉：按云端 / 本地 / 其他分组 */
function ProviderSelect({
  value,
  disabled,
  onChange,
}: {
  value: string
  disabled: boolean
  onChange: (provider: string) => void
}) {
  const info = providerInfo(value)
  return (
    <Field
      label={t('提供方')}
      hint={
        info.protocol === 'openai'
          ? t('按 OpenAI 兼容接口发送，自动处理这家的地址和参数差异')
          : t('使用这家的原生接口，支持思考过程、图片和工具调用')
      }
    >
      <select
        className={selectClass}
        value={value}
        disabled={disabled}
        aria-label={t('提供方')}
        onChange={(e) => onChange(e.target.value)}
      >
        {groups.map((g) => (
          <optgroup key={g.id} label={pt(g.label)}>
            {PROVIDERS.filter((p) => p.group === g.id).map((p) => (
              <option key={p.id} value={p.id}>
                {providerLabel(p)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {info.docsUrl && (
        <a
          className="mt-1 inline-block text-xs text-violet-600 hover:underline"
          href={info.docsUrl}
          target="_blank"
          rel="noreferrer"
        >
          {t('查看文档')}
        </a>
      )}
    </Field>
  )
}

/**
 * 提供方目录（shared/providers.ts）里的中文原文 → 当前界面语言。
 * 每条都写成显式的 t 字面量调用，i18n 测试才能检查到；目录新增文字时这里也要补。
 */
function pt(text: string): string {
  switch (text) {
    case '国际站':
      return t('国际站')
    case '国内站':
      return t('国内站')
    case '国际站（编程套餐）':
      return t('国际站（编程套餐）')
    case '带 Key':
      return t('带 Key')
    case '匿名':
      return t('匿名')
    case '快速模式填 API Key；服务账号模式粘贴整份服务账号 JSON':
      return t('快速模式填 API Key；服务账号模式粘贴整份服务账号 JSON')
    case '鉴权方式':
      return t('鉴权方式')
    case '快速模式（API Key）':
      return t('快速模式（API Key）')
    case '服务账号（JSON）':
      return t('服务账号（JSON）')
    case '区域':
      return t('区域')
    case '项目 ID':
      return t('项目 ID')
    case '留空时从服务账号 JSON 里读取':
      return t('留空时从服务账号 JSON 里读取')
    case '部署名':
      return t('部署名')
    case 'API 版本':
      return t('API 版本')
    case '账户 ID':
      return t('账户 ID')
    case '自定义（OpenAI 兼容）':
      return t('自定义（OpenAI 兼容）')
    case '云端服务':
      return t('云端服务')
    case '本地 / 自部署':
      return t('本地 / 自部署')
    case '其他':
      return t('其他')
    default:
      return text
  }
}
