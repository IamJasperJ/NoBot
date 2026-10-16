import type { CharacterDTO, CharacterUpdateInput, PromptRole } from '@ai-parter/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { keys, useCharacter, useCharacters, useLorebooks, usePersonas } from '../../api/queries'
import { NumberField, Section, SelectField } from '../../components/form'
import { ChevronLeftIcon, ChevronRightIcon } from '../../components/icons'
import { DetailHeader, EmptyDetail, ListItem, ManagerLayout } from '../../components/layout'
import { Avatar, Button, IconButton } from '../../components/ui'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { AvatarUpload, CountedArea, CountedText, moveItem, useAction } from './editor'
import { useCharacterImport } from './useCharacterImport'

export function CharactersPage() {
  const characters = useCharacters()
  const focusId = useUi((s) => s.focusId)
  const [selected, setSelected] = useState<string | null>(focusId)
  const [search, setSearch] = useState('')
  const dirty = useRef(false)
  const editorBusy = useRef(false)
  const importInput = useRef<HTMLInputElement>(null)
  const { importing, importFiles, importDialog } = useCharacterImport()
  const qc = useQueryClient()
  const { busy, run } = useAction()
  const select = (id: string | null) => {
    if (id === selected) return
    if (busy || importing || editorBusy.current || (dirty.current && !confirm('有未保存的修改，是否放弃？'))) return
    dirty.current = false
    setSelected(id)
  }
  useEffect(() => {
    if (focusId) setSelected(focusId)
  }, [focusId])
  const detail = useCharacter(selected)
  const create = () => {
    if (editorBusy.current || (dirty.current && !confirm('有未保存的修改，是否放弃？'))) return
    void run(async () => {
      const created = await api.createCharacter({ name: '新角色' })
      await qc.invalidateQueries({ queryKey: keys.characters })
      dirty.current = false
      setSelected(created.id)
    })
  }
  return (
    <ManagerLayout
      title="角色"
      showDetailOnMobile={selected !== null}
      actions={
        <>
          <Button disabled={busy || importing} onClick={create}>
            新建
          </Button>
          <Button disabled={busy || importing} onClick={() => importInput.current?.click()}>
            {importing ? '导入中…' : '导入'}
          </Button>
          {importDialog}
          <input
            ref={importInput}
            hidden
            type="file"
            accept=".png,.json"
            multiple
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              e.target.value = ''
              void importFiles(files)
            }}
          />
        </>
      }
      list={
        <div className="space-y-2">
          <CountedText label="搜索角色" hint="按名字或标签筛选角色。" value={search} onChange={setSearch} />
          {characters.isPending ? (
            <p>加载中…</p>
          ) : characters.isError ? (
            <p>{errorMessage(characters.error)}</p>
          ) : characters.data.length === 0 ? (
            <p className="p-3 text-sm text-zinc-500">点击「新建」或「导入」添加第一个角色。</p>
          ) : (
            (() => {
              const filtered = characters.data.filter((c) =>
                [c.name, ...c.tags].some((text) => text.toLocaleLowerCase().includes(search.toLocaleLowerCase())),
              )
              return filtered.length ? (
                filtered.map((c) => (
                  <ListItem key={c.id} active={c.id === selected} onClick={() => select(c.id)}>
                    <Avatar name={c.name} url={c.avatarUrl} />
                    <span className="truncate">{c.name}</span>
                  </ListItem>
                ))
              ) : (
                <p>没有匹配的角色。</p>
              )
            })()
          )}
        </div>
      }
      detail={
        !selected ? (
          <EmptyDetail text="选择一个角色查看和编辑，或新建角色。" />
        ) : detail.isPending ? (
          <>
            <DetailHeader title="角色" onBack={() => select(null)} />
            <p className="p-4">加载中…</p>
          </>
        ) : detail.isError ? (
          <>
            <DetailHeader title="角色" onBack={() => select(null)} />
            <p className="p-4">{errorMessage(detail.error)}</p>
          </>
        ) : (
          <CharacterEditor
            key={selected}
            character={detail.data}
            onBack={() => select(null)}
            onDirty={(value, blocked) => {
              dirty.current = value
              editorBusy.current = blocked
            }}
            onSelect={(id) => {
              dirty.current = false
              editorBusy.current = false
              setSelected(id)
            }}
          />
        )
      }
    />
  )
}

function CharacterEditor({
  character,
  onBack,
  onDirty,
  onSelect,
}: {
  character: CharacterDTO
  onBack: () => void
  onDirty: (value: boolean, blocked: boolean) => void
  onSelect: (id: string | null) => void
}) {
  const [original, setOriginal] = useState(() => structuredClone(character))
  const [draft, setDraft] = useState(() => structuredClone(character))
  const [tags, setTags] = useState(character.tags.join(', '))
  const lorebooks = useLorebooks()
  const personas = usePersonas()
  const qc = useQueryClient()
  const openChat = useUi((s) => s.openChat)
  const { busy, run } = useAction()
  const dirty = JSON.stringify(draft) !== JSON.stringify(original) || tags !== original.tags.join(', ')
  useEffect(() => {
    onDirty(dirty, busy)
  }, [dirty, busy, onDirty])
  const patch = <K extends keyof CharacterDTO>(key: K, value: CharacterDTO[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: keys.characters }),
      qc.invalidateQueries({ queryKey: keys.character(character.id) }),
    ])
  }
  const save = () =>
    void run(async () => {
      const { id: _id, avatarUrl: _avatar, createdAt: _created, updatedAt: _updated, ...input } = draft
      const result = await api.updateCharacter(character.id, input satisfies CharacterUpdateInput)
      setDraft(structuredClone(result))
      setOriginal(structuredClone(result))
      setTags(result.tags.join(', '))
      await refresh()
      toast.info('角色已保存')
    })
  const area = (
    key:
      | 'description'
      | 'personality'
      | 'scenario'
      | 'first_mes'
      | 'mes_example'
      | 'system_prompt'
      | 'post_history_instructions'
      | 'creator_notes'
      | 'characterNote',
    label: string,
    hint: string,
    rows = 4,
  ) => <CountedArea label={label} hint={hint} rows={rows} value={draft[key]} onChange={(value) => patch(key, value)} />
  return (
    <>
      <DetailHeader title={draft.name} onBack={onBack} />
      <fieldset disabled={busy} className="min-w-0 space-y-5 p-4 sm:p-6">
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={!dirty || !draft.name.trim()} onClick={save}>
            保存
          </Button>
          <Button
            disabled={!dirty}
            onClick={() => {
              setDraft(structuredClone(original))
              setTags(original.tags.join(', '))
            }}
          >
            撤销修改
          </Button>
          <Button
            onClick={() => {
              if (dirty && !confirm('有未保存的修改，是否放弃并开始聊天？')) return
              void run(async () => {
                const chat = await api.createChat({ characterId: character.id })
                openChat({ characterId: character.id }, chat.id)
              })
            }}
          >
            开始聊天
          </Button>
          <Button
            onClick={() => {
              if (dirty && !confirm('复制使用已保存的角色，有未保存的修改，是否放弃并继续？')) return
              void run(async () => {
                const copy = await api.duplicateCharacter(character.id)
                await refresh()
                onSelect(copy.id)
              })
            }}
          >
            复制
          </Button>
          <Button onClick={() => api.exportCharacter(character.id, 'png')}>导出 PNG</Button>
          <Button onClick={() => api.exportCharacter(character.id, 'json')}>导出 JSON</Button>
          <Button
            variant="danger"
            onClick={() => {
              if (confirm(`确定删除「${original.name}」？它的所有会话也会一起删除。`))
                void run(async () => {
                  await api.deleteCharacter(character.id)
                  await refresh()
                  onSelect(null)
                })
            }}
          >
            删除
          </Button>
        </div>
        <p className="text-xs text-zinc-500">编辑后点击保存；复制、导出和开始聊天使用已保存的角色资料。</p>
        <AvatarUpload
          name={draft.name}
          url={draft.avatarUrl}
          disabled={busy}
          onUpload={(file) =>
            void run(async () => {
              const result = await api.setCharacterAvatar(character.id, file)
              setDraft((d) => ({ ...d, avatarUrl: result.avatarUrl }))
              setOriginal((d) => ({ ...d, avatarUrl: result.avatarUrl }))
              await refresh()
            })
          }
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <CountedText
            label="名字"
            hint="角色在列表和对话中显示的名字。"
            value={draft.name}
            onChange={(v) => patch('name', v)}
          />
          <CountedText
            label="标签"
            hint="用逗号分隔多个标签，方便搜索角色。"
            value={tags}
            onChange={(v) => {
              setTags(v)
              patch(
                'tags',
                v
                  .split(/[,，]/)
                  .map((t) => t.trim())
                  .filter(Boolean),
              )
            }}
          />
          <CountedText
            label="作者"
            hint="记录角色卡作者的名字。"
            value={draft.creator}
            onChange={(v) => patch('creator', v)}
          />
          <CountedText
            label="版本"
            hint="记录角色卡版本，方便区分修订。"
            value={draft.character_version}
            onChange={(v) => patch('character_version', v)}
          />
        </div>
        <Section title="基础设定">
          {area('description', '描述', '介绍角色的外貌、背景和身份。', 8)}
          {area('personality', '性格', '描述角色的性格与行为习惯。')}
          {area('scenario', '场景', '设定对话发生的地点和背景。')}
          {area('first_mes', '开场白', '新建会话时角色发出的第一条消息。', 6)}
          <div className="space-y-3">
            <p className="text-sm font-medium">备选开场白</p>
            <p className="text-xs text-zinc-500">新建会话时可以左右滑动切换开场白</p>
            {draft.alternate_greetings.map((greeting, index) => (
              <div key={index} className="space-y-2">
                <CountedArea
                  label={`备选开场白 ${index + 1}`}
                  hint="提供另一种开始对话的方式。"
                  value={greeting}
                  onChange={(value) =>
                    patch(
                      'alternate_greetings',
                      draft.alternate_greetings.map((g, i) => (i === index ? value : g)),
                    )
                  }
                />
                <Button
                  variant="danger"
                  onClick={() =>
                    patch(
                      'alternate_greetings',
                      draft.alternate_greetings.filter((_, i) => i !== index),
                    )
                  }
                >
                  删除此开场白
                </Button>
              </div>
            ))}
            <Button onClick={() => patch('alternate_greetings', [...draft.alternate_greetings, ''])}>添加开场白</Button>
          </div>
        </Section>
        <Section title="进阶设定">
          {area(
            'mes_example',
            '对话示例',
            '用 <START> 分隔示例，以 {{user}}: / {{char}}: 为前缀，示范角色的说话风格。',
            8,
          )}
          {area('system_prompt', '主提示词', '填写后会替代预设里的主提示词，可用 {{original}} 引用原文')}
          {area(
            'post_history_instructions',
            '历史后指令',
            '填写后会替代预设里的历史后指令，可用 {{original}} 引用原文',
          )}
          {area('creator_notes', '作者说明', '只给人看，不发给模型')}
        </Section>
        <Section title="角色备注" description="对应酒馆的 Character's Note，按深度插入聊天记录。">
          {area('characterNote', '备注内容', '把需要持续提醒模型的设定插入聊天记录。')}
          <NumberField
            label="插入深度"
            hint="从最新消息向前数，0 表示放在聊天记录末尾。"
            value={draft.characterNoteDepth}
            min={0}
            max={Number.MAX_SAFE_INTEGER}
            slider={false}
            onChange={(v) => patch('characterNoteDepth', Math.round(v))}
          />
          <SelectField<PromptRole>
            label="备注身份"
            hint="选择这段备注以系统、用户或助手身份发送。"
            value={draft.characterNoteRole}
            options={[
              { value: 'system', label: '系统' },
              { value: 'user', label: '用户' },
              { value: 'assistant', label: '助手' },
            ]}
            onChange={(v) => patch('characterNoteRole', v)}
          />
        </Section>
        <Section title="群聊">
          <NumberField
            label="发言积极度"
            hint="群聊里没被点名时开口的概率"
            value={draft.talkativeness}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => patch('talkativeness', v)}
          />
        </Section>
        <Section title="关联">
          <p className="text-sm font-medium">关联世界书</p>
          <p className="text-xs text-zinc-500">第一本是导出角色卡时嵌入的主世界书</p>
          {draft.lorebookIds.map((id, i) => (
            <div key={id} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 break-words">
                {i + 1}. {lorebooks.data?.find((b) => b.id === id)?.name ?? '世界书不可用'}
              </span>
              <IconButton
                label="上移"
                className="shrink-0"
                disabled={i === 0}
                onClick={() => patch('lorebookIds', moveItem(draft.lorebookIds, i, -1))}
              >
                <ChevronLeftIcon className="rotate-90" />
              </IconButton>
              <IconButton
                label="下移"
                className="shrink-0"
                disabled={i === draft.lorebookIds.length - 1}
                onClick={() => patch('lorebookIds', moveItem(draft.lorebookIds, i, 1))}
              >
                <ChevronRightIcon className="rotate-90" />
              </IconButton>
              <Button
                onClick={() =>
                  patch(
                    'lorebookIds',
                    draft.lorebookIds.filter((b) => b !== id),
                  )
                }
              >
                移除
              </Button>
            </div>
          ))}
          {lorebooks.isPending ? (
            <p>加载中…</p>
          ) : lorebooks.isError ? (
            <p>{errorMessage(lorebooks.error)}</p>
          ) : (
            <SelectField
              label="添加世界书"
              hint="按添加顺序关联世界书，可在上方调整优先顺序。"
              value=""
              options={[
                { value: '', label: '选择要添加的世界书' },
                ...lorebooks.data
                  .filter((b) => !draft.lorebookIds.includes(b.id))
                  .map((b) => ({ value: b.id, label: b.name })),
              ]}
              onChange={(id) => {
                if (id) patch('lorebookIds', [...draft.lorebookIds, id])
              }}
            />
          )}
          {personas.isPending ? (
            <p>加载中…</p>
          ) : personas.isError ? (
            <p>{errorMessage(personas.error)}</p>
          ) : (
            <SelectField
              label="默认人设"
              hint="使用此角色新建会话时，优先选择这个用户人设。"
              value={draft.defaultPersonaId ?? ''}
              options={[
                { value: '', label: '使用全局默认人设' },
                ...personas.data.map((p) => ({ value: p.id, label: p.name })),
              ]}
              onChange={(id) => patch('defaultPersonaId', id || null)}
            />
          )}
        </Section>
      </fieldset>
    </>
  )
}
