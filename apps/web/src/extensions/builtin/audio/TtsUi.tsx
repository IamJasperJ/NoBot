import { type CharacterDTO, type MessageDTO, TTS_ENGINES, type TtsEngineId, type VoiceRef } from '@nobot/shared'
import { useState } from 'react'
import { useClearTtsCache, useTtsCache } from '../../../api/tts'
import { Button } from '../../../components/ui'
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
  const update = async (next: VoiceRef | null) => {
    setValue(next)
    // 选了引擎但还没选声音时先不保存，免得存进一个空声音
    if (next && !next.voice) return
    setSaving(true)
    try {
      const { nobot_tts: _old, ...rest } = character.extensions
      await save({ extensions: next ? { ...rest, nobot_tts: next } : rest })
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
