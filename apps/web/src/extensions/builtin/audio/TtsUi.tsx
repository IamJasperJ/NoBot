import {
  type CharacterDTO,
  GENDERS,
  type Gender,
  type MessageDTO,
  TTS_ENGINES,
  type TtsEngineId,
  type VoiceRef,
} from '@nobot/shared'
import { useState } from 'react'
import { useClearTtsCache, useTtsCache } from '../../../api/tts'
import { Button, controlClass, cx, selectClass } from '../../../components/ui'
import { t } from '../../../i18n'
import { errorMessage, toast } from '../../../stores/toast'
import type { SlotProps } from '../../types'
import { ttsPlayer, useTtsPlayback } from './tts-player'
import { VoiceListPicker, VoicePicker } from './VoicePicker'

// 编辑中的声音允许 voice 为空（刚选了引擎、还没选声音），只要求引擎合法；保存后服务端会忽略这种未完成的条目
const asVoice = (value: unknown): VoiceRef | null => {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<Record<keyof VoiceRef, unknown>>
  if (!TTS_ENGINES.includes(v.engine as TtsEngineId)) return null
  return {
    engine: v.engine as TtsEngineId,
    voice: typeof v.voice === 'string' ? v.voice : '',
    speed: typeof v.speed === 'number' ? v.speed : 1,
    // 声音池里手动标的性别要保留，否则表单重绘后丢失
    ...(GENDERS.includes(v.gender as Gender) ? { gender: v.gender as Gender } : {}),
  }
}
const asVoices = (value: unknown): VoiceRef[] =>
  Array.isArray(value) ? value.map(asVoice).filter((v): v is VoiceRef => v !== null) : []

/** 设置表单里自定义字段的外框：标签 + 说明 + 控件，和自动生成的字段对齐 */
function FieldShell({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5 py-1">
      <div>
        <div className="text-[13px] font-medium">{label}</div>
        {hint && <div className="text-xs text-zinc-500">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

/** 扩展设置里的单个声音字段（旁白声音、用户声音） */
export function VoiceField(props: SlotProps['extensions.settings.field']) {
  return (
    <FieldShell label={props.label} hint={props.hint}>
      <VoicePicker
        value={asVoice(props.value)}
        onChange={props.onChange}
        settings={props.settings}
        disabled={props.disabled}
      />
    </FieldShell>
  )
}

/** 扩展设置里的 NPC 声音池 */
export function VoiceListField(props: SlotProps['extensions.settings.field']) {
  return (
    <FieldShell label={props.label} hint={props.hint}>
      <VoiceListPicker
        value={asVoices(props.value)}
        onChange={props.onChange}
        settings={props.settings}
        disabled={props.disabled}
      />
    </FieldShell>
  )
}

/** 角色编辑器里的「声音」分组：声音存在角色卡的 extensions.nobot_tts 上，导出时随卡带走 */
export function CharacterVoiceSection({
  character,
  save,
}: {
  character: CharacterDTO
  save: (patch: { extensions: Record<string, unknown> }) => Promise<void>
}) {
  const [value, setValue] = useState<VoiceRef | null>(asVoice(character.extensions.nobot_tts))
  const [saving, setSaving] = useState(false)
  const savedStyle =
    typeof character.extensions.nobot_tts_style === 'string' ? character.extensions.nobot_tts_style : ''
  const [style, setStyle] = useState(savedStyle)
  // 失焦时保存；没改动不发请求，清空就从卡上删掉这个字段
  const saveStyle = async () => {
    const next = style.trim()
    if (next === savedStyle) return
    setSaving(true)
    try {
      await save({ extensions: { nobot_tts_style: next || null } })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }
  const [gender, setGender] = useState(
    typeof character.extensions.nobot_gender === 'string' ? character.extensions.nobot_gender : '',
  )
  // 空串表示自动：从卡上删掉这个字段
  const saveGender = async (next: string) => {
    setGender(next)
    setSaving(true)
    try {
      await save({ extensions: { nobot_gender: next || null } })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }
  const update = async (next: VoiceRef | null) => {
    setValue(next)
    // 选了引擎但还没选声音时先不保存，免得存进一个空声音
    if (next && !next.voice) return
    setSaving(true)
    try {
      await save({ extensions: { nobot_tts: next } })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-500">
        {t('朗读这个角色的台词时用的声音。不设置时从「音频」扩展设置里的 NPC 声音池按名字分配。')}
      </p>
      <VoicePicker value={value} onChange={(next) => void update(next)} disabled={saving} />
      <label className="flex items-center justify-between gap-3 pt-1">
        <span className="min-w-0">
          <span className="block text-[13px] font-medium">{t('性别')}</span>
          <span className="block text-xs text-zinc-500">
            {t('没给角色设声音时，按性别从声音池里挑。「自动」由模型根据角色描述判断一次。')}
          </span>
        </span>
        <select
          className={cx(selectClass, 'h-8 w-28 shrink-0 pl-2.5 text-[13px]')}
          disabled={saving}
          value={gender}
          onChange={(e) => void saveGender(e.target.value)}
        >
          <option value="">{t('自动')}</option>
          <option value="male">{t('男')}</option>
          <option value="female">{t('女')}</option>
          <option value="other">{t('其他')}</option>
        </select>
      </label>
      <label className="block space-y-1 pt-1">
        <span className="text-[13px] font-medium">{t('演绎风格')}</span>
        <span className="block text-xs text-zinc-500">
          {t(
            '用英文写这个角色一贯的说话方式，例如 speaks softly, slightly shy, occasional stutter。支持自然语言指令的引擎会参考它；留空则不加。',
          )}
        </span>
        <textarea
          rows={2}
          maxLength={200}
          disabled={saving}
          className={cx(controlClass, 'w-full px-2.5 py-1.5 text-[13px]')}
          value={style}
          placeholder="speaks softly, slightly shy"
          onChange={(e) => setStyle(e.target.value)}
          onBlur={() => void saveStyle()}
        />
      </label>
    </div>
  )
}

/** 消息「⋯」菜单里的朗读 / 停止朗读 */
export function ReadAloudAction({ message, close }: { message: MessageDTO; close?: () => void }) {
  const playing = useTtsPlayback((s) => s.playing && s.messageId === message.id)
  if (!message.content.trim()) return null
  return (
    <button
      type="button"
      className="rounded px-3 py-1.5 text-left text-sm hover:bg-zinc-500/10"
      onClick={() => {
        close?.()
        if (playing) ttsPlayer.stop()
        else
          void ttsPlayer.speakMessage(message.id).catch((e: unknown) => {
            toast.error(errorMessage(e))
          })
      }}
    >
      {playing ? t('停止朗读') : t('朗读')}
    </button>
  )
}

/** 扩展设置表单下方：朗读缓存占用和清理 */
export function TtsCacheFooter() {
  const cache = useTtsCache()
  const clear = useClearTtsCache()
  const mb = cache.data ? cache.data.bytes / 1024 / 1024 : 0
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-zinc-100 pt-3 text-[13px] dark:border-zinc-800">
      <span className="text-zinc-500">
        {cache.data
          ? t('朗读缓存：{count} 个文件，{size} MB', { count: cache.data.files, size: mb.toFixed(1) })
          : t('朗读缓存：读取中…')}
      </span>
      <Button
        size="sm"
        disabled={!cache.data?.files || clear.isPending}
        onClick={() => {
          if (confirm(t('清空朗读缓存？之后重听会重新合成。')))
            clear.mutate(undefined, {
              onError: (e) => toast.error(errorMessage(e)),
              onSuccess: () => toast.info(t('已清空朗读缓存')),
            })
        }}
      >
        {t('清空缓存')}
      </Button>
    </div>
  )
}
