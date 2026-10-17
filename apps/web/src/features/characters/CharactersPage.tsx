import type { CharacterDTO, CharacterUpdateInput, PromptRole } from '@ai-parter/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { keys, useCharacter, useCharacters, useLorebooks, usePersonas } from '../../api/queries'
import { NumberField, Section, SelectField } from '../../components/form'
import {
  ChatIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  SearchIcon,
  TrashIcon,
} from '../../components/icons'
import { DetailHeader, ListItem, ManagerLayout } from '../../components/layout'
import { Menu, MenuDivider, MenuEntry } from '../../components/menu'
import { TagInput, tagShape } from '../../components/tags'
import { Avatar, Button, controlClass, cx, IconButton } from '../../components/ui'
import { Slot } from '../../extensions/Slot'
import { getLanguage, t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { AvatarUpload, CountedArea, CountedText, moveItem, useAction } from './editor'
import { SpriteManager } from './SpriteManager'
import { useCharacterImport } from './useCharacterImport'

export function CharactersPage() {
  const characters = useCharacters()
  const focusId = useUi((s) => s.focusId)
  const [selected, setSelected] = useState<string | null>(focusId)
  const [search, setSearch] = useState('')
  const [tagFilter, setTagFilter] = useState<string[]>([])
  const dirty = useRef(false)
  const editorBusy = useRef(false)
  const importInput = useRef<HTMLInputElement>(null)
  const { importing, importFiles, importDialog } = useCharacterImport()
  const qc = useQueryClient()
  const { busy, run } = useAction()
  const select = (id: string | null) => {
    if (id === selected) return
    if (busy || importing || editorBusy.current || (dirty.current && !confirm(t('有未保存的修改，是否放弃？')))) return
    dirty.current = false
    setSelected(id)
  }
  useEffect(() => {
    if (focusId) setSelected(focusId)
  }, [focusId])
  const detail = useCharacter(selected)
  const create = () => {
    if (editorBusy.current || (dirty.current && !confirm(t('有未保存的修改，是否放弃？')))) return
    void run(async () => {
      const created = await api.createCharacter({ name: t('新角色') })
      await qc.invalidateQueries({ queryKey: keys.characters })
      dirty.current = false
      setSelected(created.id)
    })
  }
  return (
    <ManagerLayout
      title={t('角色')}
      showDetailOnMobile={selected !== null}
      actions={
        <>
          <Button disabled={busy || importing} onClick={create}>
            {t('新建')}
          </Button>
          <Button disabled={busy || importing} onClick={() => importInput.current?.click()}>
            {importing ? t('导入中…') : t('导入')}
          </Button>
          {importDialog}
          <input
            ref={importInput}
            hidden
            type="file"
            accept=".png,.json,.charx"
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
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-zinc-400" />
            <input
              className={cx(controlClass, 'pl-8')}
              placeholder={t('搜索角色（名字或标签）')}
              aria-label={t('搜索角色')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {characters.data && characters.data.length > 0 && (
            <TagFilter characters={characters.data} selected={tagFilter} onChange={setTagFilter} />
          )}
          {characters.isPending ? (
            <p className="p-3 text-sm text-zinc-500">{t('加载中…')}</p>
          ) : characters.isError ? (
            <p className="p-3 text-sm text-red-600">{errorMessage(characters.error)}</p>
          ) : characters.data.length === 0 ? (
            <p className="p-3 text-sm text-zinc-500">{t('点击「新建」或「导入」添加第一个角色。')}</p>
          ) : (
            (() => {
              const query = search.trim().toLocaleLowerCase()
              const filtered = characters.data.filter(
                (c) =>
                  tagFilter.every((tag) => c.tags.includes(tag)) &&
                  [c.name, ...c.tags].some((text) => text.toLocaleLowerCase().includes(query)),
              )
              return filtered.length ? (
                filtered.map((c) => (
                  <ListItem key={c.id} active={c.id === selected} onClick={() => select(c.id)}>
                    <Avatar name={c.name} url={c.avatarUrl} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{c.name}</span>
                      {c.tags.length > 0 && (
                        <span className="block truncate text-xs text-zinc-400">{c.tags.join(' · ')}</span>
                      )}
                    </span>
                  </ListItem>
                ))
              ) : (
                <p className="p-3 text-sm text-zinc-500">{t('没有匹配的角色。')}</p>
              )
            })()
          )}
        </div>
      }
      detail={
        !selected ? null : detail.isPending ? (
          <>
            <DetailHeader title={t('角色')} onBack={() => select(null)} />
            <p className="p-4">{t('加载中…')}</p>
          </>
        ) : detail.isError ? (
          <>
            <DetailHeader title={t('角色')} onBack={() => select(null)} />
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

export function CharacterEditor({
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
  const lorebooks = useLorebooks()
  const personas = usePersonas()
  const qc = useQueryClient()
  const openChat = useUi((s) => s.openChat)
  const { busy, run } = useAction()
  const dirty = JSON.stringify(draft) !== JSON.stringify(original)
  const allTags = [...new Set((useCharacters().data ?? []).flatMap((c) => c.tags))].sort((a, b) =>
    a.localeCompare(b, getLanguage() === 'en' ? 'en-US' : 'zh-CN'),
  )
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
      await refresh()
      toast.info(t('角色已保存'))
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
      <DetailHeader
        title={draft.name}
        onBack={onBack}
        actions={
          <div className="flex items-center gap-1.5">
            {dirty && <span className="mr-1 hidden text-xs text-amber-600 sm:inline">{t('未保存')}</span>}
            <Button
              size="sm"
              variant="ghost"
              disabled={!dirty || busy}
              onClick={() => {
                setDraft(structuredClone(original))
              }}
            >
              {t('撤销修改')}
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                if (dirty && !confirm(t('有未保存的修改，是否放弃并开始聊天？'))) return
                void run(async () => {
                  const chat = await api.createChat({ characterId: character.id })
                  useUi.getState().openView('chat')
                  openChat({ characterId: character.id }, chat.id)
                })
              }}
            >
              <ChatIcon />
              {t('开始聊天')}
            </Button>
            <Button size="sm" variant="primary" disabled={busy || !dirty || !draft.name.trim()} onClick={save}>
              {t('保存')}
            </Button>
            <Menu>
              <MenuEntry
                icon={<CopyIcon />}
                disabled={busy}
                onClick={() => {
                  if (dirty && !confirm(t('复制使用已保存的角色，有未保存的修改，是否放弃并继续？'))) return
                  void run(async () => {
                    const copy = await api.duplicateCharacter(character.id)
                    await refresh()
                    onSelect(copy.id)
                  })
                }}
              >
                {t('复制')}
              </MenuEntry>
              <MenuEntry icon={<DownloadIcon />} onClick={() => api.exportCharacter(character.id, 'png')}>
                {t('导出 PNG')}
              </MenuEntry>
              <MenuEntry icon={<DownloadIcon />} onClick={() => api.exportCharacter(character.id, 'json')}>
                {t('导出 JSON')}
              </MenuEntry>
              <MenuDivider />
              <MenuEntry
                icon={<TrashIcon />}
                danger
                disabled={busy}
                onClick={() => {
                  if (confirm(t('确定删除「{name}」？它的所有会话也会一起删除。', { name: original.name })))
                    void run(async () => {
                      await api.deleteCharacter(character.id)
                      await refresh()
                      onSelect(null)
                    })
                }}
              >
                {t('删除')}
              </MenuEntry>
            </Menu>
          </div>
        }
      />
      <fieldset disabled={busy} className="mx-auto w-full max-w-3xl min-w-0 space-y-5 p-4 sm:p-6">
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
            label={t('名字')}
            hint={t('角色在列表和对话中显示的名字。')}
            value={draft.name}
            onChange={(v) => patch('name', v)}
          />
          <div className="space-y-1.5 sm:col-span-2">
            <span className="block text-[13px] font-medium text-zinc-800 dark:text-zinc-200">{t('标签')}</span>
            <TagInput value={draft.tags} suggestions={allTags} onChange={(v) => patch('tags', v)} />
            <p className="text-xs text-zinc-500">
              {t('导入酒馆角色卡时自动带上卡里的标签；在角色列表里可以按标签筛选')}
            </p>
          </div>
          <CountedText
            label={t('作者')}
            hint={t('记录角色卡作者的名字。')}
            value={draft.creator}
            onChange={(v) => patch('creator', v)}
          />
          <CountedText
            label={t('版本')}
            hint={t('记录角色卡版本，方便区分修订。')}
            value={draft.character_version}
            onChange={(v) => patch('character_version', v)}
          />
        </div>
        <Section title={t('基础设定')}>
          {area('description', t('描述'), t('介绍角色的外貌、背景和身份。'), 8)}
          {area('personality', t('性格'), t('描述角色的性格与行为习惯。'))}
          {area('scenario', t('场景'), t('设定对话发生的地点和背景。'))}
          {area('first_mes', t('开场白'), t('新建会话时角色发出的第一条消息。'), 6)}
          <div className="space-y-3">
            <p className="text-sm font-medium">{t('备选开场白')}</p>
            <p className="text-xs text-zinc-500">{t('新建会话时可以左右滑动切换开场白')}</p>
            {draft.alternate_greetings.map((greeting, index) => (
              <div key={index} className="space-y-2">
                <CountedArea
                  label={t('备选开场白 {index}', { index: index + 1 })}
                  hint={t('提供另一种开始对话的方式。')}
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
                  {t('删除此开场白')}
                </Button>
              </div>
            ))}
            <Button onClick={() => patch('alternate_greetings', [...draft.alternate_greetings, ''])}>
              {t('添加开场白')}
            </Button>
          </div>
        </Section>
        <Section title={t('进阶设定')}>
          {area(
            'mes_example',
            t('对话示例'),
            t('用 <START> 分隔示例，以 {{user}}: / {{char}}: 为前缀，示范角色的说话风格。'),
            8,
          )}
          {area('system_prompt', t('主提示词'), t('填写后会替代预设里的主提示词，可用 {{original}} 引用原文'))}
          {area(
            'post_history_instructions',
            t('历史后指令'),
            t('填写后会替代预设里的历史后指令，可用 {{original}} 引用原文'),
          )}
          {area('creator_notes', t('作者说明'), t('只给人看，不发给模型'))}
        </Section>
        <Section title={t('角色备注')} description={t("对应酒馆的 Character's Note，按深度插入聊天记录。")}>
          {area('characterNote', t('备注内容'), t('把需要持续提醒模型的设定插入聊天记录。'))}
          <NumberField
            label={t('插入深度')}
            hint={t('从最新消息向前数，0 表示放在聊天记录末尾。')}
            value={draft.characterNoteDepth}
            min={0}
            max={Number.MAX_SAFE_INTEGER}
            slider={false}
            onChange={(v) => patch('characterNoteDepth', Math.round(v))}
          />
          <SelectField<PromptRole>
            label={t('备注身份')}
            hint={t('选择这段备注以系统、用户或助手身份发送。')}
            value={draft.characterNoteRole}
            options={[
              { value: 'system', label: t('系统') },
              { value: 'user', label: t('用户') },
              { value: 'assistant', label: t('助手') },
            ]}
            onChange={(v) => patch('characterNoteRole', v)}
          />
        </Section>
        <Section title={t('群聊')}>
          <NumberField
            label={t('发言积极度')}
            hint={t('群聊里没被点名时开口的概率')}
            value={draft.talkativeness}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => patch('talkativeness', v)}
          />
        </Section>
        <Section title={t('关联')}>
          <p className="text-sm font-medium">{t('关联世界书')}</p>
          <p className="text-xs text-zinc-500">{t('第一本是导出角色卡时嵌入的主世界书')}</p>
          {draft.lorebookIds.map((id, i) => (
            <div key={id} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 break-words">
                {i + 1}. {lorebooks.data?.find((b) => b.id === id)?.name ?? t('世界书不可用')}
              </span>
              <IconButton
                label={t('上移')}
                className="shrink-0"
                disabled={i === 0}
                onClick={() => patch('lorebookIds', moveItem(draft.lorebookIds, i, -1))}
              >
                <ChevronLeftIcon className="rotate-90" />
              </IconButton>
              <IconButton
                label={t('下移')}
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
                {t('移除')}
              </Button>
            </div>
          ))}
          {lorebooks.isPending ? (
            <p>{t('加载中…')}</p>
          ) : lorebooks.isError ? (
            <p>{errorMessage(lorebooks.error)}</p>
          ) : (
            <SelectField
              label={t('添加世界书')}
              hint={t('按添加顺序关联世界书，可在上方调整优先顺序。')}
              value=""
              options={[
                { value: '', label: t('选择要添加的世界书') },
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
            <p>{t('加载中…')}</p>
          ) : personas.isError ? (
            <p>{errorMessage(personas.error)}</p>
          ) : (
            <SelectField
              label={t('默认人设')}
              hint={t('使用此角色新建会话时，优先选择这个用户人设。')}
              value={draft.defaultPersonaId ?? ''}
              options={[
                { value: '', label: t('使用全局默认人设') },
                ...personas.data.map((p) => ({ value: p.id, label: p.name })),
              ]}
              onChange={(id) => patch('defaultPersonaId', id || null)}
            />
          )}
        </Section>
        <SpriteManager characterId={character.id} />
        <Slot
          name="character.editor.sections"
          props={{
            character,
            save: async (patch) => {
              // 读取最新扩展数据，防止多个分组依次保存时覆盖彼此；普通表单草稿仍保留。
              const latest = await api.getCharacter(character.id)
              const result = await api.updateCharacter(character.id, {
                extensions: { ...latest.extensions, ...patch.extensions },
              })
              setDraft((d) => ({ ...d, extensions: result.extensions }))
              setOriginal((d) => ({ ...d, extensions: result.extensions }))
              await refresh()
            },
          }}
        />
      </fieldset>
    </>
  )
}

/** 角色列表上方的标签筛选：点选标签只显示带有这些标签的角色（多选为同时满足） */
function TagFilter({
  characters,
  selected,
  onChange,
}: {
  characters: { tags: string[] }[]
  selected: string[]
  onChange: (tags: string[]) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const counts = new Map<string, number>()
  for (const c of characters) for (const tag of c.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  const tags = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], getLanguage() === 'en' ? 'en-US' : 'zh-CN'),
  )
  if (!tags.length) return null
  const visible = expanded ? tags : tags.slice(0, 10)
  return (
    <div className="flex flex-wrap items-center gap-1 px-0.5">
      {visible.map(([tag, count]) => {
        const on = selected.includes(tag)
        return (
          <button
            key={tag}
            type="button"
            aria-pressed={on}
            className={cx(
              tagShape,
              'transition-colors',
              on
                ? 'bg-violet-600 text-white hover:bg-violet-500'
                : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700',
            )}
            onClick={() => onChange(on ? selected.filter((t) => t !== tag) : [...selected, tag])}
          >
            {tag}
            <span className={on ? 'text-violet-200' : 'text-zinc-400'}>{count}</span>
          </button>
        )
      })}
      {tags.length > 10 && (
        <button
          type="button"
          className="h-6 px-1.5 text-xs text-zinc-500 hover:text-zinc-900"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? t('收起') : t('更多 {count}', { count: tags.length - 10 })}
        </button>
      )}
      {selected.length > 0 && (
        <button
          type="button"
          className="h-6 px-1.5 text-xs text-violet-600 hover:underline"
          onClick={() => onChange([])}
        >
          {t('清除筛选')}
        </button>
      )}
    </div>
  )
}
