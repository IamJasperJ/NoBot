import {
  type GroupActivation,
  type GroupDTO,
  type GroupGenerationMode,
  type GroupInput,
  groupInput,
} from '@ai-parter/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { keys, useCharacters } from '../../api/queries'
import { Section, SelectField, SwitchField, Toggle } from '../../components/form'
import { ChevronLeftIcon, ChevronRightIcon, TrashIcon } from '../../components/icons'
import { Avatar, Button, Dialog, IconButton } from '../../components/ui'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { CountedArea, CountedText, moveItem, useAction } from '../characters/editor'

export function GroupDialog(props: {
  open: boolean
  groupId: string | null
  onClose: () => void
  onSaved: (group: GroupDTO) => void
}) {
  const close = useRef(props.onClose)
  return (
    <Dialog
      open={props.open}
      onClose={() => {
        if (props.open) close.current()
      }}
      title={props.groupId ? t('编辑群组') : t('新建群组')}
    >
      {props.open && <GroupEditor key={props.groupId ?? 'new'} {...props} closeHandler={close} />}
    </Dialog>
  )
}

function GroupEditor({
  groupId,
  onClose,
  onSaved,
  closeHandler,
}: {
  groupId: string | null
  onClose: () => void
  onSaved: (group: GroupDTO) => void
  closeHandler: { current: () => void }
}) {
  const detail = useQuery({
    queryKey: keys.group(groupId ?? ''),
    queryFn: () => api.getGroup(groupId as string),
    enabled: groupId !== null,
  })
  const characters = useCharacters()
  const qc = useQueryClient()
  const [original, setOriginal] = useState<GroupInput>(() => ({
    name: t('新群组'),
    members: [],
    activation: 'natural',
    generationMode: 'swap',
    allowSelfResponses: false,
    autoMode: false,
    scenarioOverride: '',
  }))
  const [draft, setDraft] = useState<GroupInput>(() => structuredClone(original))
  const [loaded, setLoaded] = useState(groupId === null)
  const [group, setGroup] = useState<GroupDTO | null>(null)
  const [search, setSearch] = useState('')
  const { busy, run } = useAction()
  useEffect(() => {
    if (!detail.data || loaded) return
    const result = detail.data
    const value: GroupInput = {
      name: result.name,
      activation: result.activation,
      generationMode: result.generationMode,
      allowSelfResponses: result.allowSelfResponses,
      autoMode: result.autoMode,
      scenarioOverride: result.scenarioOverride,
      members: result.members.map((m) => ({ characterId: m.characterId, muted: m.muted })),
    }
    setGroup(result)
    setOriginal(value)
    setDraft(structuredClone(value))
    setLoaded(true)
  }, [detail.data, loaded])
  const dirty = JSON.stringify(draft) !== JSON.stringify(original)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = () => {
      if (busy) return
      if (dirty && !confirm(t('有未保存的修改，是否放弃？'))) return
      onClose()
    }
    closeHandler.current = close
    // 阻止原生 Esc 先关闭弹窗，取消放弃草稿时仍保留对话框。
    const dialog = root.current?.closest('dialog')
    const cancel = (event: Event) => {
      event.preventDefault()
      close()
    }
    dialog?.addEventListener('cancel', cancel)
    return () => {
      dialog?.removeEventListener('cancel', cancel)
    }
  }, [busy, dirty, onClose, closeHandler])
  const close = () => closeHandler.current()
  const patch = <K extends keyof GroupInput>(key: K, value: GroupInput[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const members = draft.members
  const filtered =
    characters.data?.filter(
      (c) =>
        !members.some((m) => m.characterId === c.id) && c.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
    ) ?? []
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: keys.groups })
    if (groupId) await qc.invalidateQueries({ queryKey: keys.group(groupId) })
  }
  return (
    <div ref={root} className="space-y-4">
      {detail.isError ? (
        <p role="alert">{errorMessage(detail.error)}</p>
      ) : !loaded ? (
        <p>{t('加载中…')}</p>
      ) : (
        <fieldset disabled={busy} className="min-w-0 space-y-5">
          <CountedText
            label={t('群名')}
            hint={t('在群组列表和会话中显示的名字。')}
            value={draft.name}
            onChange={(v) => patch('name', v)}
          />
          <Section title={t('成员')} description={t('上方成员列表的顺序决定「列表顺序」模式中的发言次序。')}>
            {members.length === 0 && <p className="text-sm text-zinc-500">{t('从下方角色列表添加至少一位成员。')}</p>}
            {members.map((member, i) => {
              const character =
                characters.data?.find((c) => c.id === member.characterId) ??
                group?.members.find((m) => m.characterId === member.characterId)
              return (
                <div
                  key={member.characterId}
                  className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800"
                >
                  <div className="flex h-11 min-w-[23rem] items-center gap-2 px-2">
                    <Toggle
                      label={t('静音{name}', { name: character?.name ?? t('未知角色') })}
                      checked={member.muted ?? false}
                      onChange={(muted) =>
                        patch(
                          'members',
                          members.map((m, index) => (index === i ? { ...m, muted } : m)),
                        )
                      }
                    />
                    <Avatar name={character?.name ?? t('未知角色')} url={character?.avatarUrl} size={28} />
                    <span className="min-w-[8em] flex-1 truncate text-sm">
                      {i + 1}. {character?.name ?? t('角色已不可用')}
                    </span>

                    <div className="flex shrink-0">
                      <IconButton
                        label={t('上移')}
                        className="shrink-0"
                        disabled={i === 0}
                        onClick={() => patch('members', moveItem(members, i, -1))}
                      >
                        <ChevronLeftIcon className="rotate-90" />
                      </IconButton>
                      <IconButton
                        label={t('下移')}
                        className="shrink-0"
                        disabled={i === members.length - 1}
                        onClick={() => patch('members', moveItem(members, i, 1))}
                      >
                        <ChevronRightIcon className="rotate-90" />
                      </IconButton>
                      <IconButton
                        label={t('移除')}
                        className="shrink-0"
                        onClick={() =>
                          patch(
                            'members',
                            members.filter((m) => m.characterId !== member.characterId),
                          )
                        }
                      >
                        <TrashIcon />
                      </IconButton>
                    </div>
                  </div>
                </div>
              )
            })}
            <CountedText
              label={t('搜索可添加的角色')}
              hint={t('按名字筛选，点击角色即可加入群组。')}
              value={search}
              onChange={setSearch}
            />
            {characters.isPending ? (
              <p>{t('加载中…')}</p>
            ) : characters.isError ? (
              <p>{errorMessage(characters.error)}</p>
            ) : (
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {filtered.length === 0 ? (
                  <p className="text-sm text-zinc-500">
                    {characters.data.length === 0
                      ? t('暂无角色，请先到角色页创建或导入。')
                      : t('没有可添加的匹配角色。')}
                  </p>
                ) : (
                  filtered.map((c) => (
                    <Button
                      key={c.id}
                      className="w-full justify-start"
                      onClick={() => patch('members', [...members, { characterId: c.id, muted: false }])}
                    >
                      <Avatar name={c.name} url={c.avatarUrl} />
                      <span className="truncate">{c.name}</span>
                      <span className="ml-auto shrink-0">{t('加入')}</span>
                    </Button>
                  ))
                )}
              </div>
            )}
          </Section>
          <SelectField<GroupActivation>
            label={t('发言顺序')}
            hint={t(
              '自然顺序优先回应点名，否则按积极度随机；列表顺序每人说一次；轮流随机从本轮未发言者中抽取；手动点名需你指定发言者。',
            )}
            value={draft.activation ?? 'natural'}
            options={[
              { value: 'natural', label: t('自然顺序') },
              { value: 'list', label: t('列表顺序') },
              { value: 'pooled', label: t('轮流随机') },
              { value: 'manual', label: t('手动点名') },
            ]}
            onChange={(v) => patch('activation', v)}
          />
          <SelectField<GroupGenerationMode>
            label={t('角色卡生成方式')}
            hint={t('决定每次回复携带哪些成员的角色设定；合并全部成员默认不含静音成员。')}
            value={draft.generationMode ?? 'swap'}
            options={[
              { value: 'swap', label: t('只用当前发言者的角色卡') },
              { value: 'join', label: t('合并全部成员的角色卡') },
              { value: 'join_include_muted', label: t('合并全部成员（含静音）') },
            ]}
            onChange={(v) => patch('generationMode', v)}
          />
          <SwitchField
            label={t('允许回应自己')}
            hint={t('自然顺序时，允许角色回应自己上一条消息中的点名。')}
            checked={draft.allowSelfResponses ?? false}
            onChange={(v) => patch('allowSelfResponses', v)}
          />
          <SwitchField
            label={t('自动模式')}
            hint={t('让 AI 之间自动接着聊，目前只保存设置，暂不生效。')}
            notImplemented
            checked={draft.autoMode ?? false}
            onChange={(v) => patch('autoMode', v)}
          />
          <CountedArea
            label={t('场景覆盖')}
            hint={t('填写后代替所有成员的场景')}
            value={draft.scenarioOverride ?? ''}
            onChange={(v) => patch('scenarioOverride', v)}
          />
        </fieldset>
      )}
      <div className="flex flex-wrap gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <Button
          variant="primary"
          disabled={busy || !loaded || !members.length || !draft.name.trim() || (!!groupId && !dirty)}
          onClick={() =>
            void run(async () => {
              const result = groupInput.safeParse(draft)
              if (!result.success) {
                toast.error(t('请填写群名，并添加至少一位成员。'))
                return
              }
              const saved = groupId ? await api.updateGroup(groupId, result.data) : await api.createGroup(result.data)
              const savedInput = groupInput.parse(saved)
              setOriginal(savedInput)
              setDraft(structuredClone(savedInput))
              setGroup(saved)
              await refresh()
              onSaved(saved)
            })
          }
        >
          {t('保存')}
        </Button>
        <Button disabled={busy} onClick={close}>
          {t('取消')}
        </Button>
        {groupId && loaded && (
          <>
            <Button disabled={busy || !dirty} onClick={() => setDraft(structuredClone(original))}>
              {t('撤销修改')}
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const usage = await api.groupUsage(groupId)
                  const message =
                    usage.chats > 0
                      ? t(
                          '这个群组还有 {count} 个会话，会和群组一起进回收站，可以在角色页的「回收站」里恢复。确定删除？',
                          {
                            count: usage.chats,
                          },
                        )
                      : t('删除这个群组？可以在角色页的「回收站」里恢复。')
                  if (!confirm(message)) return
                  await api.deleteGroup(groupId)
                  if (useUi.getState().groupId === groupId) useUi.getState().openChat({}, null)
                  await refresh()
                  onClose()
                })
              }
            >
              {t('删除群组')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
