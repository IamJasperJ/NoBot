import type { ChatPage, UpdateChatInput } from '@ai-parter/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { keys, useConnections, useLorebooks, usePersonas, usePresets } from '../../api/queries'
import { NumberField, Section, SelectField, TextAreaField, TextField } from '../../components/form'
import { XIcon } from '../../components/icons'
import { Avatar, Button, IconButton } from '../../components/ui'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { GroupDialog } from '../groups/GroupDialog'

type Draft = Required<Omit<UpdateChatInput, 'title'>> & { title: string }

function toDraft(page: ChatPage): Draft {
  const c = page.chat
  return {
    title: c.title,
    personaId: c.personaId,
    apiPresetId: c.apiPresetId,
    promptPresetId: c.promptPresetId,
    authorNote: c.authorNote,
    authorNoteDepth: c.authorNoteDepth,
    authorNoteRole: c.authorNoteRole,
    lorebookIds: c.lorebookIds,
  }
}

/** 下拉框里的「空值」：用全局默认 */
const DEFAULT = '__default__'

/** 右侧面板：当前会话的设置 */
export function ChatSettings({ page }: { page: ChatPage }) {
  const qc = useQueryClient()
  const setOpen = useUi((s) => s.setChatSettingsOpen)
  const personas = usePersonas()
  const presets = usePresets()
  const connections = useConnections()
  const lorebooks = useLorebooks()
  const [draft, setDraft] = useState<Draft>(() => toDraft(page))
  const [groupDialog, setGroupDialog] = useState(false)
  const chatId = page.chat.id

  // 会话数据在别处被刷新时同步过来（没有未保存的修改时）
  const original = toDraft(page)
  const dirty = JSON.stringify(draft) !== JSON.stringify(original)
  useEffect(() => {
    if (!dirty) setDraft(toDraft(page))
  }, [page])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const pick = (v: string) => (v === DEFAULT ? null : v)

  const save = async () => {
    try {
      await api.updateChat(chatId, draft)
      await qc.invalidateQueries({ queryKey: keys.chat(chatId) })
      const owner = page.chat.groupId ? { groupId: page.chat.groupId } : { characterId: page.chat.characterId ?? '' }
      await qc.invalidateQueries({ queryKey: keys.chats(owner) })
      toast.info('已保存会话设置')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const defaultName = (list: { name: string; isDefault: boolean }[] | undefined) =>
    `全局默认（${list?.find((x) => x.isDefault)?.name ?? '未设置'}）`

  return (
    <aside className="fixed inset-0 z-30 flex flex-col bg-white lg:static lg:w-96 lg:shrink-0 lg:border-l lg:border-zinc-200 dark:bg-zinc-950 lg:dark:border-zinc-800">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800">
        <div className="flex-1 font-semibold">会话设置</div>
        <Button variant="primary" disabled={!dirty} onClick={save}>
          保存
        </Button>
        <IconButton label="关闭" onClick={() => setOpen(false)}>
          <XIcon />
        </IconButton>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        <TextField label="会话名称" value={draft.title} onChange={(v) => set('title', v)} />

        <Section title="人设与预设">
          <SelectField
            label="用户人设"
            hint="你在这个会话里扮演谁，{{user}} 会替换成人设的名字"
            value={draft.personaId ?? DEFAULT}
            onChange={(v) => set('personaId', pick(v))}
            options={[
              { value: DEFAULT, label: defaultName(personas.data) },
              ...(personas.data ?? []).map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
          <SelectField
            label="生成预设"
            hint="采样参数和 Prompt 结构，可以在「生成预设」页编辑"
            value={draft.promptPresetId ?? DEFAULT}
            onChange={(v) => set('promptPresetId', pick(v))}
            options={[
              { value: DEFAULT, label: defaultName(presets.data) },
              ...(presets.data ?? []).map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
          <SelectField
            label="连接"
            hint="用哪个接口和模型"
            value={draft.apiPresetId ?? DEFAULT}
            onChange={(v) => set('apiPresetId', pick(v))}
            options={[
              { value: DEFAULT, label: defaultName(connections.data) },
              ...(connections.data ?? []).map((p) => ({ value: p.id, label: `${p.name}（${p.model}）` })),
            ]}
          />
        </Section>

        <Section title="会话世界书" description="只在这个会话里生效，优先级最高">
          {lorebooks.data?.length === 0 && (
            <p className="text-sm text-zinc-500">还没有世界书，去「世界书」页新建或导入</p>
          )}
          {lorebooks.data?.map((b) => (
            <label key={b.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="accent-violet-600"
                checked={draft.lorebookIds.includes(b.id)}
                onChange={(e) =>
                  set(
                    'lorebookIds',
                    e.target.checked ? [...draft.lorebookIds, b.id] : draft.lorebookIds.filter((x) => x !== b.id),
                  )
                }
              />
              <span className="flex-1 truncate">{b.name}</span>
              <span className="text-xs text-zinc-400">
                {b.isGlobal ? '全局 · ' : ''}
                {b.entryCount} 条
              </span>
            </label>
          ))}
        </Section>

        <Section title="作者注释" description="按深度插进聊天记录，适合临时引导剧情走向">
          <TextAreaField
            label="内容"
            hint="可以用 {{char}}、{{user}} 等宏；留空则不发送"
            rows={4}
            value={draft.authorNote}
            onChange={(v) => set('authorNote', v)}
          />
          <NumberField
            label="插入深度"
            hint="0 表示放在最后一条消息之后，1 表示倒数第一条之前，以此类推"
            min={0}
            max={100}
            slider={false}
            value={draft.authorNoteDepth}
            onChange={(v) => set('authorNoteDepth', v)}
          />
          <SelectField
            label="以什么角色发送"
            value={draft.authorNoteRole}
            onChange={(v) => set('authorNoteRole', v)}
            options={[
              { value: 'system', label: '系统（system）' },
              { value: 'user', label: '用户（user）' },
              { value: 'assistant', label: '助手（assistant）' },
            ]}
          />
        </Section>

        {page.group && (
          <Section title="群聊成员">
            <div className="space-y-1.5">
              {page.group.members.map((m) => (
                <div key={m.characterId} className="flex items-center gap-2 text-sm">
                  <Avatar name={m.name} url={m.avatarUrl} size={24} />
                  <span className="flex-1">{m.name}</span>
                  {m.muted && <span className="text-xs text-zinc-400">已静音</span>}
                </div>
              ))}
            </div>
            <Button onClick={() => setGroupDialog(true)}>编辑群组</Button>
            <GroupDialog
              open={groupDialog}
              groupId={page.group.id}
              onClose={() => setGroupDialog(false)}
              onSaved={() => {
                setGroupDialog(false)
                void qc.invalidateQueries({ queryKey: keys.chat(chatId) })
                void qc.invalidateQueries({ queryKey: keys.groups })
              }}
            />
          </Section>
        )}

        <Section title="跑团状态" description="由工具调用（set_chat_state）记录，随分支和重新生成自动回退">
          {Object.keys(page.vars).length === 0 ? (
            <p className="text-sm text-zinc-500">
              暂无状态。在生成预设里开启「工具调用」后，模型可以用 set_chat_state 记录 HP、背包等数值。
            </p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {Object.entries(page.vars).map(([k, v]) => (
                  <tr key={k} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                    <td className="py-1 pr-2 font-medium whitespace-nowrap">{k}</td>
                    <td className="py-1 break-all text-zinc-600 dark:text-zinc-300">
                      {typeof v === 'string' ? v : JSON.stringify(v)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      </div>
    </aside>
  )
}
