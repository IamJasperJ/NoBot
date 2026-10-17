import type { ChatPage, UpdateChatInput } from '@ai-parter/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import {
  keys,
  useAutoBackground,
  useBackgrounds,
  useChatPages,
  useConnections,
  useLorebooks,
  usePersonas,
  usePlayPresets,
  usePresets,
} from '../../api/queries'
import { NumberField, Section, SelectField, TextAreaField, TextField, Toggle } from '../../components/form'
import { WandIcon, XIcon } from '../../components/icons'
import { Avatar, Button, cx, IconButton } from '../../components/ui'
import { useStreaming } from '../../stores/streaming'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { GroupDialog } from '../groups/GroupDialog'
import { runGeneration } from './generate'

// 背景和固定开关在背景页里即时保存，不进会话设置的草稿
type Draft = Required<Omit<UpdateChatInput, 'title' | 'backgroundId' | 'backgroundPinned'>> & { title: string }

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
    playPresetId: c.playPresetId,
  }
}

/** 下拉框里的「空值」：用全局默认 */
const DEFAULT = '__default__'

/** 侧栏位置的面板：当前会话的设置。会话数据从已加载的缓存里取 */
export function ChatSettings({ chatId }: { chatId: string }) {
  const pages = useChatPages(chatId)
  const page = pages.data?.pages[0]
  if (!page) return <div className="p-4 text-sm text-zinc-400">加载中…</div>
  return <ChatSettingsForm page={page} />
}

function ChatSettingsForm({ page }: { page: ChatPage }) {
  const qc = useQueryClient()
  const setOpen = useUi((s) => s.setChatSettingsOpen)
  const personas = usePersonas()
  const presets = usePresets()
  const playPresets = usePlayPresets()
  const effectivePlay = playPresets.data?.find((p) => p.id === page.playPresetId)
  const connections = useConnections()
  const lorebooks = useLorebooks()
  const auto = useAutoBackground()
  const backgrounds = useBackgrounds()
  const background = backgrounds.data?.find((b) => b.id === page.chat.backgroundId)
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
    <aside className="flex h-full w-full flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800">
        <div className="flex-1 truncate font-semibold">会话设置</div>
        <Button variant="primary" disabled={!dirty} onClick={save}>
          保存
        </Button>
        <IconButton label="返回会话列表" onClick={() => setOpen(false)}>
          <XIcon />
        </IconButton>
      </header>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {page.group && <GroupMembers page={page} onEdit={() => setGroupDialog(true)} />}
        {page.group && (
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
        )}

        <TextField label="会话名称" value={draft.title} onChange={(v) => set('title', v)} />

        <Section dense title="人设与预设">
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
            label="玩法预设"
            hint="VN 模式的玩法（指令、变量、立绘……），在「设置」里编辑。跟随：用角色卡指定的预设，没有就用默认"
            value={draft.playPresetId ?? DEFAULT}
            onChange={(v) => set('playPresetId', pick(v))}
            options={[
              {
                value: DEFAULT,
                label: `跟随${effectivePlay && !draft.playPresetId ? `（${effectivePlay.name}）` : ''}`,
              },
              ...(playPresets.data ?? []).map((p) => ({ value: p.id, label: p.name })),
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

        <Section title="聊天背景" description="只对这个会话生效，清除后跟随全局背景">
          <div className="flex items-center gap-3">
            <div className="h-12 w-20 shrink-0 overflow-hidden rounded-lg bg-zinc-100 ring-1 ring-black/5 dark:bg-zinc-800 dark:ring-white/10">
              {background &&
                (background.mime.startsWith('video/') ? (
                  <video src={background.thumbUrl} muted preload="metadata" className="size-full object-cover" />
                ) : (
                  <img src={background.thumbUrl} alt="" className="size-full object-cover" />
                ))}
            </div>
            <span className={cx('min-w-0 flex-1 truncate text-sm', background ? 'font-medium' : 'text-zinc-400')}>
              {background?.name ?? '跟随全局'}
            </span>
          </div>
          {page.stage?.scene.bg && page.chat.backgroundPinned && page.chat.backgroundId ? (
            <p className="text-xs text-zinc-500">
              已固定：舞台换场景时不切换背景。可以在背景页的「舞台」一行点「跟随舞台」恢复。
            </p>
          ) : (
            page.stage?.scene.bg && (
              <p className="text-xs text-zinc-500">
                现在生效的是舞台背景：
                {backgrounds.data?.find((b) => b.id === page.stage?.scene.backgroundId)?.name ??
                  `「${page.stage.scene.bg}」（没有匹配的背景，暂用上面的）`}
              </p>
            )
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => useUi.getState().openView('backgrounds')}>
              选择…
            </Button>
            <Button
              size="sm"
              disabled={auto.isPending}
              onClick={() =>
                auto.mutate(chatId, {
                  onSuccess: ({ background }) => toast.info(`已选择：${background.name}`),
                  onError: (error) => toast.error(errorMessage(error)),
                })
              }
            >
              <WandIcon />
              {auto.isPending ? '选择中…' : '自动选择'}
            </Button>
            {page.chat.backgroundId && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  try {
                    await api.updateChat(chatId, { backgroundId: null })
                    await qc.invalidateQueries({ queryKey: keys.chat(chatId) })
                  } catch (e) {
                    toast.error(errorMessage(e))
                  }
                }}
              >
                清除
              </Button>
            )}
          </div>
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

        <Section dense title="作者注释" description="按深度插进聊天记录，适合临时引导剧情走向">
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

        <Section
          title="状态变量"
          description="来自状态定义的初始值、正文里的 <state> 指令和工具调用，随分支和重新生成自动回退"
        >
          {Object.keys(page.vars).length === 0 ? (
            <p className="text-sm text-zinc-500">
              暂无状态。可以在玩法预设里定义变量，或在生成预设里开启「工具调用」让模型用 set_chat_state 记录。
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

/**
 * 群聊成员的快捷操作：禁言开关（立即保存到群组）、「让 TA 说」（马上让这个角色发言，即使被禁言也会说）。
 */
function GroupMembers({ page, onEdit }: { page: ChatPage; onEdit: () => void }) {
  const qc = useQueryClient()
  const group = page.group as NonNullable<ChatPage['group']>
  const chatId = page.chat.id
  const generating = useStreaming((s) => s.chatId === chatId) || page.generating

  const setMuted = async (characterId: string, muted: boolean) => {
    try {
      await api.updateGroup(group.id, {
        members: group.members.map((m) => ({
          characterId: m.characterId,
          muted: m.characterId === characterId ? muted : m.muted,
        })),
      })
      await qc.invalidateQueries({ queryKey: keys.chat(chatId) })
      await qc.invalidateQueries({ queryKey: keys.groups })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const talk = (characterId: string) =>
    runGeneration(qc, chatId, { mode: 'trigger', speakerId: characterId }).catch((e) => toast.error(errorMessage(e)))

  return (
    <Section title="群聊成员" description="开关控制是否自动发言；「让 TA 说」立刻让这个角色回复">
      <div className="space-y-1">
        {group.members.map((m) => (
          <div key={m.characterId} className="flex items-center gap-2 text-sm">
            <Toggle
              label={m.muted ? `取消 ${m.name} 的禁言` : `禁言 ${m.name}`}
              checked={!m.muted}
              onChange={(on) => setMuted(m.characterId, !on)}
            />
            <Avatar name={m.name} url={m.avatarUrl} size={24} />
            <span
              className={m.muted ? 'min-w-0 flex-1 truncate text-zinc-400 line-through' : 'min-w-0 flex-1 truncate'}
            >
              {m.name}
            </span>
            <Button className="shrink-0 px-2 py-1 text-xs" disabled={generating} onClick={() => talk(m.characterId)}>
              让 TA 说
            </Button>
          </div>
        ))}
      </div>
      <Button onClick={onEdit}>编辑群组</Button>
    </Section>
  )
}
