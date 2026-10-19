import type { ProfileDTO, ProfileInput, RegexScript } from '@nobot/shared'
import { type ReactNode, useState } from 'react'
import { useConnections, useExtensions, usePresets, useProfileMutations, useProfiles } from '../../api/queries'
import { Section, SelectField, TextField } from '../../components/form'
import { CheckIcon, TrashIcon } from '../../components/icons'
import { DetailHeader, ListItem, ManagerLayout } from '../../components/layout'
import { Menu, MenuEntry } from '../../components/menu'
import { Button } from '../../components/ui'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'

/**
 * 连接配置组（对应酒馆的 Connection Profiles）：把聊天连接、模型、生成预设、正则规则、图片连接打包成一组，
 * 可以设为全局默认、绑定到角色，或在会话里临时切换。生效顺序：会话 > 角色 > 全局默认 > 旧的单独设置。
 */

type Draft = Required<Omit<ProfileInput, 'regexScripts'>> & { regexScripts: RegexScript[] | null }

const emptyDraft = (): Draft => ({
  name: '',
  apiPresetId: null,
  promptPresetId: null,
  model: '',
  regexScripts: null,
  imageConnectionId: null,
  promptConnectionId: null,
})
const toDraft = (p: ProfileDTO): Draft => ({
  name: p.name,
  apiPresetId: p.apiPresetId,
  promptPresetId: p.promptPresetId,
  model: p.model,
  regexScripts: p.regexScripts,
  imageConnectionId: p.imageConnectionId,
  promptConnectionId: p.promptConnectionId,
})

/** 下拉框里「不指定」用空串表示，存的时候换成 null */
const orNull = (v: string) => v || null

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

  const connectionOptions = (empty: string) => [
    { value: '', label: empty },
    ...(connections.data ?? []).map((c) => ({ value: c.id, label: `${c.name}（${c.model}）` })),
  ]
  const chosen = connections.data?.find((c) => c.id === draft?.apiPresetId)

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
                <TextField
                  label={t('模型')}
                  hint={t('留空使用连接里设置的模型')}
                  placeholder={chosen?.model ?? ''}
                  value={draft.model}
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
                  label={t('图片生成连接')}
                  hint={t('图片生成扩展里没选「复用连接」时，用这里的连接出图（OpenAI 兼容 / OpenRouter）')}
                  value={draft.imageConnectionId ?? ''}
                  onChange={(v) => setDraft({ ...draft, imageConnectionId: orNull(v) })}
                  options={connectionOptions(t('不指定'))}
                />
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
