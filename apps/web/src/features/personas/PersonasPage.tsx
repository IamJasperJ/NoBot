import type { PersonaDTO } from '@ai-parter/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { keys, useLorebooks, usePersonas } from '../../api/queries'
import { SelectField } from '../../components/form'
import { CheckIcon, TrashIcon } from '../../components/icons'
import { DetailHeader, ListItem, ManagerLayout } from '../../components/layout'
import { Menu, MenuEntry } from '../../components/menu'
import { Avatar, Button, badgeClass, cx } from '../../components/ui'
import { errorMessage, toast } from '../../stores/toast'
import { AvatarUpload, CountedArea, CountedText, useAction } from '../characters/editor'

export function PersonasPage() {
  const personas = usePersonas()
  const qc = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const dirty = useRef(false)
  const editorBusy = useRef(false)
  const { busy, run } = useAction()
  const select = (id: string | null) => {
    if (selected === id || busy || editorBusy.current) return
    if (dirty.current && !confirm('有未保存的修改，是否放弃？')) return
    dirty.current = false
    setSelected(id)
  }
  const persona = personas.data?.find((p) => p.id === selected)
  return (
    <ManagerLayout
      detailIn="panel"
      title="人设"
      showDetailOnMobile={selected !== null}
      actions={
        <Button
          disabled={busy}
          onClick={() => {
            if (editorBusy.current || (dirty.current && !confirm('有未保存的修改，是否放弃？'))) return
            void run(async () => {
              const created = await api.createPersona({ name: '新人设' })
              await qc.invalidateQueries({ queryKey: keys.personas })
              dirty.current = false
              editorBusy.current = false
              setSelected(created.id)
            })
          }}
        >
          新建
        </Button>
      }
      list={
        personas.isPending ? (
          <p>加载中…</p>
        ) : personas.isError ? (
          <p>{errorMessage(personas.error)}</p>
        ) : personas.data.length === 0 ? (
          <p className="p-3 text-sm text-zinc-500">点击「新建」添加一个用户人设。</p>
        ) : (
          personas.data.map((p) => (
            <ListItem key={p.id} active={p.id === selected} onClick={() => select(p.id)}>
              <Avatar name={p.name} url={p.avatarUrl} />
              <span className="truncate">{p.name}</span>
              {p.isDefault && <span className="shrink-0 text-xs text-violet-600">默认</span>}
            </ListItem>
          ))
        )
      }
      detail={
        persona ? (
          <PersonaEditor
            key={persona.id}
            persona={persona}
            onBack={() => select(null)}
            onDirty={(value, blocked) => {
              dirty.current = value
              editorBusy.current = blocked
            }}
            onDeleted={() => {
              dirty.current = false
              editorBusy.current = false
              setSelected(null)
            }}
          />
        ) : selected ? (
          <>
            <DetailHeader title="人设" onBack={() => select(null)} />
            <p className="p-4">
              {personas.isPending
                ? '加载中…'
                : personas.isError
                  ? errorMessage(personas.error)
                  : '该人设已不存在，请返回列表选择其他人设。'}
            </p>
          </>
        ) : null
      }
    />
  )
}

function PersonaEditor({
  persona,
  onBack,
  onDirty,
  onDeleted,
}: {
  persona: PersonaDTO
  onBack: () => void
  onDirty: (value: boolean, blocked: boolean) => void
  onDeleted: () => void
}) {
  const [original, setOriginal] = useState(() => structuredClone(persona))
  const [draft, setDraft] = useState(() => structuredClone(persona))
  const lorebooks = useLorebooks()
  const qc = useQueryClient()
  const { busy, run } = useAction()
  const dirty = JSON.stringify(draft) !== JSON.stringify(original)
  useEffect(() => {
    onDirty(dirty, busy)
  }, [dirty, busy, onDirty])
  const refresh = () => qc.invalidateQueries({ queryKey: keys.personas })
  const updateAvatar = (result: PersonaDTO) => {
    setDraft((d) => ({ ...d, avatarUrl: result.avatarUrl }))
    setOriginal((d) => ({ ...d, avatarUrl: result.avatarUrl }))
  }
  return (
    <>
      <DetailHeader title={draft.name} onBack={onBack} />
      <fieldset disabled={busy} className="min-w-0 space-y-5 p-3">
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="primary"
            disabled={!dirty || !draft.name.trim()}
            onClick={() =>
              void run(async () => {
                const result = await api.updatePersona(persona.id, {
                  name: draft.name,
                  description: draft.description,
                  lorebookId: draft.lorebookId,
                })
                setDraft(structuredClone(result))
                setOriginal(structuredClone(result))
                await refresh()
                toast.info('人设已保存')
              })
            }
          >
            保存
          </Button>
          <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => setDraft(structuredClone(original))}>
            撤销修改
          </Button>
          {persona.isDefault && <span className={cx(badgeClass, 'ml-1')}>默认人设</span>}
          <div className="ml-auto">
            <Menu>
              {!persona.isDefault && (
                <MenuEntry
                  icon={<CheckIcon />}
                  onClick={() =>
                    void run(async () => {
                      await api.setDefaultPersona(persona.id)
                      await refresh()
                      toast.info('已设为默认人设')
                    })
                  }
                >
                  设为默认
                </MenuEntry>
              )}
              <MenuEntry
                icon={<TrashIcon />}
                danger
                onClick={() => {
                  if (
                    confirm(`确定删除人设「${original.name}」？它的名字、描述和头像将被删除，已有会话会改用默认人设。`)
                  )
                    void run(async () => {
                      await api.deletePersona(persona.id)
                      await refresh()
                      onDeleted()
                    })
                }}
              >
                删除
              </MenuEntry>
            </Menu>
          </div>
        </div>
        <p className="text-xs text-zinc-500">默认人设用于没有单独指定人设的新会话；点击「设为默认」立即生效。</p>
        <AvatarUpload
          name={draft.name}
          url={draft.avatarUrl}
          disabled={busy}
          onUpload={(file) =>
            void run(async () => {
              updateAvatar(await api.setPersonaAvatar(persona.id, file))
              await refresh()
            })
          }
        />
        <Button
          disabled={!draft.avatarUrl}
          onClick={() =>
            void run(async () => {
              updateAvatar(await api.removePersonaAvatar(persona.id))
              await refresh()
            })
          }
        >
          移除头像
        </Button>
        <p className="text-xs text-zinc-500">移除后使用名字首字作为头像，立即生效。</p>
        <CountedText
          label="名字"
          hint="角色卡里的 {{user}} 会替换成这个名字"
          value={draft.name}
          onChange={(name) => setDraft((d) => ({ ...d, name }))}
        />
        <CountedArea
          label="描述"
          hint="作为『用户人设』放进 Prompt"
          rows={6}
          value={draft.description}
          onChange={(description) => setDraft((d) => ({ ...d, description }))}
        />
        {lorebooks.isPending ? (
          <p>加载中…</p>
        ) : lorebooks.isError ? (
          <p>{errorMessage(lorebooks.error)}</p>
        ) : (
          <SelectField
            label="绑定世界书"
            hint="使用这个人设时自动生效"
            value={draft.lorebookId ?? ''}
            options={[{ value: '', label: '无' }, ...lorebooks.data.map((b) => ({ value: b.id, label: b.name }))]}
            onChange={(id) => setDraft((d) => ({ ...d, lorebookId: id || null }))}
          />
        )}
      </fieldset>
    </>
  )
}
