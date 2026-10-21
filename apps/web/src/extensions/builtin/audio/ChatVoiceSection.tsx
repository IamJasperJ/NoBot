import { castKey } from '@nobot/core/stage'
import type { CharacterGender, ChatVoiceConfig, VoiceRef } from '@nobot/shared'
import { type ReactNode, useEffect, useState } from 'react'
import { useChatVoice, useInferChatGenders, useResetChatVoice, useSetChatVoice, useTtsEngines } from '../../../api/tts'
import { PlusIcon, XIcon } from '../../../components/icons'
import { Button, controlClass, cx, IconButton, selectClass } from '../../../components/ui'
import { t } from '../../../i18n'
import { errorMessage, toast } from '../../../stores/toast'
import { type ChatVoiceDraft, mergeChatVoiceDraft } from './chat-voice-draft'
import { VoicePicker } from './VoicePicker'

type Flag = 'enabled' | 'autoRead' | 'vnVoice' | 'readNarration' | 'readUser'

/** 去掉还没填完的声音（选了引擎、没选声音），服务端只收完整的 */
function sanitize(config: ChatVoiceConfig): ChatVoiceConfig {
  const done = (v: VoiceRef | null | undefined) => !v || !!v.voice
  const record = (r: Record<string, VoiceRef>) => Object.fromEntries(Object.entries(r).filter(([, v]) => v.voice))
  return {
    ...config,
    narratorVoice: done(config.narratorVoice) ? config.narratorVoice : undefined,
    userVoice: done(config.userVoice) ? config.userVoice : undefined,
    characters: record(config.characters),
    npcs: record(config.npcs),
  }
}

/**
 * 会话设置里的「声音」：按会话覆盖音频扩展的朗读设置。每一项默认「跟随全局」，
 * 改了就只对这个会话生效：朗读开关、旁白和你的声音、每个角色和 NPC 的声音。
 */
export function ChatVoiceSection({ chatId }: { chatId: string }) {
  const query = useChatVoice(chatId)
  const save = useSetChatVoice()
  const reset = useResetChatVoice()
  const infer = useInferChatGenders(chatId)
  const engines = useTtsEngines()
  const [state, setState] = useState<ChatVoiceDraft>({ chatId, config: null })
  const draft = state.chatId === chatId ? state.config : null
  const setDraft = (config: ChatVoiceConfig) => setState({ chatId, config })
  const [npcName, setNpcName] = useState('')
  useEffect(() => {
    setNpcName('')
    setState((prev) => (prev.chatId === chatId ? prev : { chatId, config: null }))
  }, [chatId])
  useEffect(() => {
    if (query.data) setState((prev) => mergeChatVoiceDraft(prev, chatId, query.data.config))
  }, [chatId, query.data])

  if (query.isLoading || !draft || !query.data) return <p className="text-sm text-zinc-500">{t('加载中…')}</p>
  if (query.error) return <p className="text-sm text-red-600">{errorMessage(query.error)}</p>
  const { members, npcs, global } = query.data

  const engineLabel = (id: string) => engines.data?.find((e) => e.id === id)?.label ?? id
  const describe = (v: VoiceRef | null) => (v ? `${engineLabel(v.engine)} · ${v.voice}` : t('无'))
  const onOff = (v: boolean) => (v ? t('开') : t('关'))
  // 回退声音来自声音池（按性别挑）；池里没有时借用旁白声音；都没有时不读
  const narrator = draft.narratorVoice === undefined ? global.narratorVoice : draft.narratorVoice
  const fallback = (v: VoiceRef | null) =>
    !v
      ? t('不读（没有可用声音）')
      : narrator && narrator.engine === v.engine && narrator.voice === v.voice
        ? t('旁白声音（{value}）', { value: describe(v) })
        : t('声音池（{value}）', { value: describe(v) })

  const update = (next: ChatVoiceConfig) => {
    setDraft(next)
    const clean = sanitize(next)
    save.mutate({ chatId, config: clean }, { onError: (e) => toast.error(errorMessage(e)) })
  }
  const flag = (key: Flag, label: string) => {
    const value = draft[key]
    return (
      <label className="flex items-center justify-between gap-3 py-1">
        <span className="min-w-0 text-[13px]">{label}</span>
        <select
          className={cx(selectClass, 'h-8 w-44 shrink-0 pl-2.5 text-[13px]')}
          value={value === undefined ? '' : value ? 'on' : 'off'}
          onChange={(e) => {
            const v = e.target.value
            const { [key]: _, ...rest } = draft
            update(v === '' ? (rest as ChatVoiceConfig) : { ...draft, [key]: v === 'on' })
          }}
        >
          <option value="">{t('跟随全局（{value}）', { value: onOff(global[key]) })}</option>
          <option value="on">{t('开')}</option>
          <option value="off">{t('关')}</option>
        </select>
      </label>
    )
  }
  const modeLabels = { off: t('不控制语气'), basic: t('按立绘表情'), rich: t('模型标注语气和声音') } as const
  /** 语气控制：跟随全局 / 关 / 按表情 / 模型标注 */
  const deliveryField = () => (
    <label className="flex items-center justify-between gap-3 py-1">
      <span className="min-w-0 text-[13px]">{t('语气控制')}</span>
      <select
        className={cx(selectClass, 'h-8 w-44 shrink-0 pl-2.5 text-[13px]')}
        value={draft.deliveryMode ?? ''}
        onChange={(e) => {
          const v = e.target.value
          const { deliveryMode: _, ...rest } = draft
          update(v === '' ? (rest as ChatVoiceConfig) : { ...draft, deliveryMode: v as keyof typeof modeLabels })
        }}
      >
        <option value="">{t('跟随全局（{value}）', { value: modeLabels[global.deliveryMode] })}</option>
        <option value="off">{modeLabels.off}</option>
        <option value="basic">{modeLabels.basic}</option>
        <option value="rich">{modeLabels.rich}</option>
      </select>
    </label>
  )
  /** 旁白、用户声音：跟随全局 / 不读 / 指定 */
  const voiceField = (key: 'narratorVoice' | 'userVoice', label: string) => {
    const value = draft[key]
    const mode = value === undefined ? 'inherit' : value === null ? 'none' : 'custom'
    return (
      <div className="space-y-1.5 py-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px]">{label}</span>
          <select
            className={cx(selectClass, 'h-8 w-44 shrink-0 pl-2.5 text-[13px]')}
            value={mode}
            onChange={(e) => {
              const m = e.target.value
              const { [key]: _, ...rest } = draft
              if (m === 'inherit') update(rest as ChatVoiceConfig)
              else if (m === 'none') update({ ...draft, [key]: null })
              else setDraft({ ...draft, [key]: global[key] ?? { engine: 'edge', voice: '', speed: 1 } })
            }}
          >
            <option value="inherit">{t('跟随全局（{value}）', { value: describe(global[key]) })}</option>
            <option value="none">{t('这个会话不读')}</option>
            <option value="custom">{t('指定声音…')}</option>
          </select>
        </div>
        {value && <VoicePicker value={value} allowNone={false} onChange={(v) => v && update({ ...draft, [key]: v })} />}
      </div>
    )
  }
  /** 角色、NPC：跟随（角色卡 / 声音池）或指定 */
  const genderLabels: Record<CharacterGender, string> = { male: t('男'), female: t('女'), other: t('其他') }
  /** 性别：会话里手动指定，否则显示角色卡或模型判断的结果（按性别从声音池挑声音） */
  const genderSelect = (key: string, gender: CharacterGender | null, source: string | null) => {
    const own = draft.genders?.[key]
    const auto = own ? null : gender
    return (
      <select
        aria-label={t('性别')}
        title={source === 'card' ? t('角色卡上设置的性别') : source === 'inferred' ? t('模型判断的性别') : t('性别')}
        className={cx(selectClass, 'h-8 w-24 shrink-0 pl-2 text-[12px]')}
        value={own ?? ''}
        onChange={(e) => {
          const v = e.target.value as CharacterGender | ''
          const { [key]: _, ...rest } = draft.genders ?? {}
          update({ ...draft, genders: v ? { ...rest, [key]: v } : rest })
        }}
      >
        <option value="">{auto ? t('自动·{value}', { value: genderLabels[auto] }) : t('自动·未知')}</option>
        <option value="male">{genderLabels.male}</option>
        <option value="female">{genderLabels.female}</option>
        <option value="other">{genderLabels.other}</option>
      </select>
    )
  }
  const overrideRow = (
    name: string,
    fallback: string,
    value: VoiceRef | undefined,
    set: (v: VoiceRef | undefined) => void,
    onRemove?: () => void,
    gender?: ReactNode,
  ) => (
    <div key={name} className="space-y-1.5 rounded-lg border border-zinc-100 px-2.5 py-2 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{name}</span>
        {gender}
        <select
          className={cx(selectClass, 'h-8 w-44 shrink-0 pl-2.5 text-[13px]')}
          value={value ? 'custom' : 'inherit'}
          onChange={(e) => set(e.target.value === 'inherit' ? undefined : { engine: 'edge', voice: '', speed: 1 })}
        >
          <option value="inherit">{fallback}</option>
          <option value="custom">{t('这个会话指定…')}</option>
        </select>
        {onRemove && (
          <IconButton label={t('移除')} className="size-8" onClick={onRemove}>
            <XIcon />
          </IconButton>
        )}
      </div>
      {value && <VoicePicker value={value} allowNone={false} onChange={(v) => v && set(v)} />}
    </div>
  )
  const setCharacter = (id: string, v: VoiceRef | undefined) => {
    const { [id]: _, ...rest } = draft.characters
    const next = { ...draft, characters: v ? { ...rest, [id]: v } : rest }
    if (v && !v.voice) setDraft(next)
    else update(next)
  }
  const setNpc = (key: string, v: VoiceRef | undefined) => {
    const { [key]: _, ...rest } = draft.npcs
    const next = { ...draft, npcs: v ? { ...rest, [key]: v } : rest }
    if (v && !v.voice) setDraft(next)
    else update(next)
  }
  // 手动加的 NPC 也要能显示：候选名单之外、但 draft 里已有覆盖的
  const npcRows = [
    ...npcs,
    ...Object.keys(draft.npcs)
      .filter((key) => !npcs.some((n) => n.key === key))
      .map((key) => ({ key, name: key, poolVoice: null, fallbackVoice: null, gender: null, genderSource: null })),
  ]
  const inferButton = (
    <Button
      size="sm"
      variant="ghost"
      disabled={infer.isPending}
      title={t('用模型判断还不知道性别的角色和 NPC，结果会缓存')}
      onClick={() =>
        infer.mutate(undefined, {
          onSuccess: () => toast.info(t('已识别性别')),
          onError: (e) => toast.error(errorMessage(e)),
        })
      }
    >
      {infer.isPending ? t('识别中…') : t('识别性别')}
    </Button>
  )
  const overridden = Object.keys(sanitize(draft)).some((k) => {
    const v = draft[k as keyof ChatVoiceConfig]
    return k === 'characters' || k === 'npcs' || k === 'genders' ? Object.keys(v ?? {}).length > 0 : v !== undefined
  })

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500">
        {t('只对这个会话生效；每一项默认跟随「音频」扩展的全局设置和角色卡上的声音。')}
      </p>

      <div>
        {flag('enabled', t('朗读'))}
        {flag('autoRead', t('新回复自动朗读'))}
        {flag('vnVoice', t('VN 里逐句朗读'))}
        {flag('readNarration', t('朗读旁白'))}
        {flag('readUser', t('朗读你的台词'))}
        {deliveryField()}
      </div>

      <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
        {voiceField('narratorVoice', t('旁白声音'))}
        {voiceField('userVoice', t('你的声音'))}
      </div>

      {members.length > 0 && (
        <div className="space-y-1.5 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-medium text-zinc-500">{t('角色')}</div>
            {inferButton}
          </div>
          {members.map((m) =>
            overrideRow(
              m.name,
              m.cardVoice ? t('角色卡（{value}）', { value: describe(m.cardVoice) }) : fallback(m.fallbackVoice),
              draft.characters[m.id],
              (v) => setCharacter(m.id, v),
              undefined,
              genderSelect(m.id, m.gender, m.genderSource),
            ),
          )}
        </div>
      )}

      <div className="space-y-1.5 border-t border-zinc-100 pt-3 dark:border-zinc-800">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-medium text-zinc-500">{t('NPC')}</div>
          {members.length === 0 && inferButton}
        </div>
        {npcRows.length === 0 && (
          <p className="text-xs text-zinc-400">{t('这个会话里还没有出现过 NPC，可以手动添加名字。')}</p>
        )}
        {npcRows.map((n) =>
          overrideRow(
            n.name,
            n.poolVoice ? t('声音池（{value}）', { value: describe(n.poolVoice) }) : fallback(n.fallbackVoice),
            draft.npcs[n.key],
            (v) => setNpc(n.key, v),
            npcs.some((c) => c.key === n.key) ? undefined : () => setNpc(n.key, undefined),
            genderSelect(n.key, 'gender' in n ? n.gender : null, 'genderSource' in n ? n.genderSource : null),
          ),
        )}
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            const name = npcName.trim()
            if (!name) return
            const key = castKey(name)
            if (!npcRows.some((n) => n.key === key)) setNpc(key, { engine: 'edge', voice: '', speed: 1 })
            setNpcName('')
          }}
        >
          <input
            className={cx(controlClass, 'h-8 min-w-0 flex-1 px-2.5 text-[13px]')}
            placeholder={t('NPC 名字')}
            value={npcName}
            onChange={(e) => setNpcName(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={!npcName.trim()}>
            <PlusIcon />
            {t('添加')}
          </Button>
        </form>
      </div>

      {overridden && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            disabled={reset.isPending}
            onClick={() => {
              if (confirm(t('清除这个会话的所有声音设置，全部恢复跟随全局？')))
                reset.mutate(chatId, { onError: (e) => toast.error(errorMessage(e)) })
            }}
          >
            {t('全部恢复跟随全局')}
          </Button>
        </div>
      )}
    </div>
  )
}
