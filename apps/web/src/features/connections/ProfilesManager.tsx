import type { ApiPresetDTO, ProfileDTO, ProfileImage, ProfileInput, RegexScript } from '@nobot/shared'
import { type ReactNode, useId, useState } from 'react'
import {
  useComfyWorkflowOptions,
  useConnectionModels,
  useImageModels,
  useImageStyleOptions,
} from '../../api/profileModels'
import { useConnections, useExtensions, usePresets, useProfileMutations, useProfiles } from '../../api/queries'
import { Combobox } from '../../components/combobox'
import { DenseRow, Section, SelectField, TextAreaField, TextField } from '../../components/form'
import { CheckIcon, RefreshIcon, TrashIcon } from '../../components/icons'
import { DetailHeader, ListItem, ManagerLayout } from '../../components/layout'
import { Menu, MenuEntry } from '../../components/menu'
import { Button, IconButton } from '../../components/ui'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'

/**
 * 连接配置组（对应酒馆的 Connection Profiles）：把聊天连接、模型、生成预设、正则规则、图片生成设置打包成一组，
 * 可以设为全局默认、绑定到角色，或在会话里临时切换。生效顺序：会话 > 角色 > 全局默认 > 旧的单独设置。
 */

type Draft = Required<Omit<ProfileInput, 'regexScripts' | 'image'>> & {
  regexScripts: RegexScript[] | null
  image: ProfileImage | null
}

const emptyDraft = (): Draft => ({
  name: '',
  apiPresetId: null,
  promptPresetId: null,
  model: '',
  regexScripts: null,
  image: null,
  promptConnectionId: null,
})
const toDraft = (p: ProfileDTO): Draft => ({
  name: p.name,
  apiPresetId: p.apiPresetId,
  promptPresetId: p.promptPresetId,
  model: p.model,
  regexScripts: p.regexScripts,
  image: p.image,
  promptConnectionId: p.promptConnectionId,
})

/** 下拉框里「不指定」用空串表示，存的时候换成 null */
const orNull = (v: string) => v || null

/** 连接在下拉框里的名字：「名字 · 域名」，比「名字（聊天模型）」更好分辨 */
function connectionLabel(c: ApiPresetDTO) {
  let host = c.baseUrl
  try {
    host = new URL(c.baseUrl).host
  } catch {}
  return host ? `${c.name} · ${host}` : c.name
}

const IMAGE_SOURCES: { value: ProfileImage['source']; label: string }[] = [
  { value: 'openai', label: 'OpenAI 兼容接口' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'comfy', label: 'ComfyUI' },
  { value: 'a1111', label: 'A1111 / Forge' },
]
const emptyImage = (source: ProfileImage['source']): ProfileImage => ({
  source,
  connectionId: null,
  url: '',
  headers: '',
  model: '',
  comfyWorkflow: null,
  style: '',
})

/** 可以手填、也可以从接口拉取后选的模型输入框；拉取结果缓存，右边按钮强制刷新 */
function ModelField({
  label,
  hint,
  value,
  placeholder,
  options,
  loading,
  error,
  onRefresh,
  onChange,
}: {
  label: string
  hint: string
  value: string
  placeholder: string
  options: string[]
  loading: boolean
  error: unknown
  onRefresh: () => void
  onChange: (v: string) => void
}) {
  const id = useId()
  return (
    <DenseRow id={id} label={label} hint={error ? `${hint}\n${errorMessage(error)}` : hint}>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <Combobox
          id={id}
          label={label}
          className="min-w-0 flex-1"
          value={value}
          options={options.map((m) => ({ value: m, label: m }))}
          disabled={false}
          placeholder={placeholder}
          onChange={onChange}
        />
        <IconButton
          label={loading ? t('拉取中…') : t('拉取模型列表')}
          className="size-8 shrink-0"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshIcon className={loading ? 'animate-spin' : undefined} />
        </IconButton>
      </div>
      {!!error && <span className="sr-only">{errorMessage(error)}</span>}
    </DenseRow>
  )
}

export function ProfilesManager({ tabs }: { tabs: ReactNode }) {
  const query = useProfiles()
  const connections = useConnections()
  const presets = usePresets()
  const extensions = useExtensions()
  const m = useProfileMutations()
  const [originalId, setOriginalId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const original = query.data?.find((p) => p.id === originalId) ?? null
  const baseline = original ? toDraft(original) : emptyDraft()
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(baseline)
  const busy = m.create.isPending || m.update.isPending || m.remove.isPending || m.setDefault.isPending
  const canLeave = () => !dirty || confirm(t('此配置组有未保存的修改，是否放弃？'))
  const pick = (p: ProfileDTO | null, create = false) => {
    setOriginalId(p?.id ?? null)
    setDraft(p ? toDraft(p) : create ? emptyDraft() : null)
  }
  // 全局正则规则（正则扩展的设置），「自定义」时以它为起点
  const globalRegex = (extensions.data?.find((e) => e.id === 'regex')?.settings.scripts ?? []) as RegexScript[]
  // 图片生成扩展里配好的地址和请求头：配置组留空时用它们，这里显示出来方便对照、一键填入
  const imageGen = extensions.data?.find((e) => e.id === 'image-gen')?.settings ?? {}
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  const extUrl = (source: ProfileImage['source']) =>
    source === 'comfy' ? text(imageGen.comfyUrl) : source === 'a1111' ? text(imageGen.a1111Url) : ''
  const extHeaders = text(imageGen.comfyHeaders)

  const connectionOptions = (empty: string) => [
    { value: '', label: empty },
    ...(connections.data ?? []).map((c) => ({ value: c.id, label: connectionLabel(c) })),
  ]
  // 不指定连接时用全局默认连接，模型列表也从它拉
  const chosen =
    connections.data?.find((c) => c.id === draft?.apiPresetId) ?? connections.data?.find((c) => c.isDefault)
  const chatModels = useConnectionModels(chosen?.id ?? null, !!draft)
  const image = draft?.image ?? null
  const imageModels = useImageModels(image, !!image)
  const workflows = useComfyWorkflowOptions()
  const styles = useImageStyleOptions()
  const setImage = (patch: Partial<ProfileImage>) =>
    draft?.image && setDraft({ ...draft, image: { ...draft.image, ...patch } })

  const save = async () => {
    if (!draft || !dirty || busy) return
    try {
      const input: ProfileInput = { ...draft, name: draft.name.trim(), model: draft.model.trim() }
      const saved = original
        ? await m.update.mutateAsync({ id: original.id, input })
        : await m.create.mutateAsync(input)
      pick(saved)
      toast.info(t('已保存配置组'))
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <ManagerLayout
      detailIn="panel"
      title={t('连接')}
      showDetailOnMobile={!!draft}
      actions={
        <Button
          disabled={busy}
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
          {query.data?.length === 0 && (
            <p className="p-3 text-sm text-zinc-500">
              {t('还没有配置组。配置组把连接、模型、生成预设和正则打包在一起，方便给角色绑定或在会话里一键切换。')}
            </p>
          )}
          {query.data?.map((p) => (
            <ListItem
              key={p.id}
              active={p.id === originalId}
              onClick={() => {
                if (!busy && p.id !== originalId && canLeave()) pick(p)
              }}
            >
              <span className="truncate">{p.name}</span>
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
              title={original ? draft.name || t('未命名配置组') : t('新建配置组')}
              onBack={() => {
                if (!busy && canLeave()) pick(null)
              }}
            />
            <form
              className="space-y-3 p-3"
              onSubmit={(event) => {
                event.preventDefault()
                void save()
              }}
            >
              <div className="flex items-center gap-1.5">
                <Button type="submit" size="sm" variant="primary" disabled={busy || !dirty || !draft.name.trim()}>
                  {t('保存')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy || !dirty} onClick={() => setDraft(baseline)}>
                  {t('撤销修改')}
                </Button>
                {original && (
                  <div className="ml-auto">
                    <Menu>
                      <MenuEntry
                        icon={<CheckIcon />}
                        onClick={() =>
                          m.setDefault.mutate(original.isDefault ? null : original.id, {
                            onError: (e) => toast.error(errorMessage(e)),
                          })
                        }
                      >
                        {original.isDefault ? t('取消全局默认') : t('设为全局默认')}
                      </MenuEntry>
                      <MenuEntry
                        icon={<TrashIcon />}
                        danger
                        onClick={() => {
                          if (
                            confirm(
                              t('删除配置组「{name}」？绑定了它的角色和会话会改回使用默认设置。', {
                                name: original.name,
                              }),
                            )
                          )
                            m.remove.mutate(original.id, {
                              onSuccess: () => pick(null),
                              onError: (e) => toast.error(errorMessage(e)),
                            })
                        }}
                      >
                        {t('删除')}
                      </MenuEntry>
                    </Menu>
                  </div>
                )}
              </div>
              <Section dense title={t('基本')}>
                <TextField label={t('名称')} value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
                <SelectField
                  label={t('聊天连接')}
                  hint={t('不指定时用全局默认连接')}
                  value={draft.apiPresetId ?? ''}
                  onChange={(v) => setDraft({ ...draft, apiPresetId: orNull(v) })}
                  options={connectionOptions(t('不指定'))}
                />
                <ModelField
                  label={t('模型')}
                  hint={t('留空使用连接里设置的模型；可以直接输入，也可以点右边按钮从连接拉取列表')}
                  value={draft.model}
                  placeholder={chosen?.model ?? ''}
                  options={chatModels.data ?? []}
                  loading={chatModels.isFetching}
                  error={chatModels.error}
                  onRefresh={() => void chatModels.refetch()}
                  onChange={(model) => setDraft({ ...draft, model })}
                />
                <SelectField
                  label={t('生成预设')}
                  hint={t('不指定时用全局默认预设')}
                  value={draft.promptPresetId ?? ''}
                  onChange={(v) => setDraft({ ...draft, promptPresetId: orNull(v) })}
                  options={[
                    { value: '', label: t('不指定') },
                    ...(presets.data ?? []).map((p) => ({ value: p.id, label: p.name })),
                  ]}
                />
              </Section>
              <Section dense title={t('图片')}>
                <SelectField
                  label={t('图片生成')}
                  hint={t('「跟随扩展」时完全使用图片生成扩展里的设置；选了后端后，下面各项留空的仍跟随扩展')}
                  value={image?.source ?? ''}
                  onChange={(v) => setDraft({ ...draft, image: v ? { ...(image ?? emptyImage(v)), source: v } : null })}
                  options={[
                    { value: '' as const, label: t('跟随图片生成扩展') },
                    ...IMAGE_SOURCES.map((o) => ({ ...o, label: t(o.label) })),
                  ]}
                />
                {image && (image.source === 'openai' || image.source === 'openrouter') && (
                  <SelectField
                    label={t('图片连接')}
                    hint={t('用哪个连接的地址和密钥出图')}
                    value={image.connectionId ?? ''}
                    onChange={(v) => setImage({ connectionId: orNull(v) })}
                    options={connectionOptions(t('跟随扩展'))}
                  />
                )}
                {image && (image.source === 'comfy' || image.source === 'a1111') && (
                  <TextField
                    label={t('服务地址')}
                    hint={
                      extUrl(image.source)
                        ? t('留空使用图片生成扩展里的地址：{url}', { url: extUrl(image.source) })
                        : t('留空跟随扩展')
                    }
                    placeholder={
                      extUrl(image.source) ||
                      (image.source === 'comfy' ? 'http://127.0.0.1:8188' : 'http://127.0.0.1:7860')
                    }
                    value={image.url}
                    onChange={(url) => setImage({ url })}
                  />
                )}
                {image?.source === 'comfy' && (
                  <TextAreaField
                    label={t('额外请求头（JSON）')}
                    hint={
                      extHeaders
                        ? t('留空使用图片生成扩展里的请求头（输入框里灰色的就是）；填了则整份替换')
                        : t('留空跟随扩展')
                    }
                    rows={2}
                    mono
                    placeholder={extHeaders}
                    value={image.headers}
                    onChange={(headers) => setImage({ headers })}
                  />
                )}
                {image &&
                  (image.source === 'comfy' || image.source === 'a1111') &&
                  !!extUrl(image.source) &&
                  (image.url !== extUrl(image.source) ||
                    (image.source === 'comfy' && image.headers !== extHeaders)) && (
                    <div className="col-span-full flex justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setImage({
                            url: extUrl(image.source),
                            ...(image.source === 'comfy' ? { headers: extHeaders } : {}),
                          })
                        }
                      >
                        {t('填入扩展里的地址和请求头')}
                      </Button>
                    </div>
                  )}
                {image && (
                  <ModelField
                    label={
                      image.source === 'comfy' || image.source === 'a1111' ? t('模型（Checkpoint）') : t('图片模型')
                    }
                    hint={t('留空跟随扩展；可以直接输入，也可以点右边按钮拉取')}
                    value={image.model}
                    placeholder={t('跟随扩展')}
                    options={(imageModels.data ?? []).map((o) => o.value)}
                    loading={imageModels.isFetching}
                    error={imageModels.error}
                    onRefresh={() => void imageModels.refetch()}
                    onChange={(model) => setImage({ model })}
                  />
                )}
                {image?.source === 'comfy' && (
                  <SelectField
                    label={t('工作流')}
                    hint={t('工作流在图片生成扩展里管理')}
                    value={image.comfyWorkflow === null ? '\u0000follow' : image.comfyWorkflow}
                    onChange={(v) => setImage({ comfyWorkflow: v === '\u0000follow' ? null : v })}
                    options={[
                      { value: '\u0000follow', label: t('跟随扩展') },
                      ...(workflows.data ?? []).map((o) => ({ value: o.value, label: o.label })),
                    ]}
                  />
                )}
                {image && (
                  <SelectField
                    label={t('风格')}
                    hint={t('风格（正负向提示词）在图片生成扩展里管理')}
                    value={image.style}
                    onChange={(style) => setImage({ style })}
                    options={[
                      { value: '', label: t('跟随扩展') },
                      ...(styles.data ?? []).map((o) => ({ value: o.value, label: o.label })),
                    ]}
                  />
                )}
                <SelectField
                  label={t('写提示词的连接')}
                  hint={t('图片生成扩展里没选写提示词的连接时，用这里的连接写生图提示词')}
                  value={draft.promptConnectionId ?? ''}
                  onChange={(v) => setDraft({ ...draft, promptConnectionId: orNull(v) })}
                  options={connectionOptions(t('跟随聊天连接'))}
                />
              </Section>
              <RegexSection
                value={draft.regexScripts}
                global={globalRegex}
                onChange={(regexScripts) => setDraft({ ...draft, regexScripts })}
              />
            </form>
          </>
        ) : null
      }
    />
  )
}

/** 正则规则：沿用全局（null）或者用这个配置组自己的一份（从全局复制后单独开关） */
function RegexSection({
  value,
  global,
  onChange,
}: {
  value: RegexScript[] | null
  global: RegexScript[]
  onChange: (v: RegexScript[] | null) => void
}) {
  return (
    <Section dense title={t('正则规则')}>
      <SelectField
        label={t('使用哪些规则')}
        hint={t('「单独设置」会复制一份当前的全局规则，之后在这里单独开关，不影响全局')}
        value={value === null ? 'global' : 'own'}
        onChange={(v) => onChange(v === 'global' ? null : global.map((s) => ({ ...s })))}
        options={[
          { value: 'global', label: t('沿用全局规则') },
          { value: 'own', label: t('单独设置') },
        ]}
      />
      {value !== null && (
        <div className="col-span-full space-y-1">
          {value.length === 0 && (
            <p className="text-xs text-zinc-500">{t('没有规则：这个配置组生效时不运行任何正则替换')}</p>
          )}
          {value.map((script, i) => (
            <label
              // 规则没有稳定 id，按位置区分
              key={i}
              className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
            >
              <input
                type="checkbox"
                checked={script.enabled}
                onChange={(e) => onChange(value.map((s, j) => (j === i ? { ...s, enabled: e.target.checked } : s)))}
              />
              <span className="min-w-0 flex-1 truncate">{script.name || t('未命名规则')}</span>
              <code className="max-w-[40%] truncate text-xs text-zinc-400">{script.find}</code>
            </label>
          ))}
        </div>
      )}
    </Section>
  )
}
