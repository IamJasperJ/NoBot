import type { DeliveryCapabilities, Gender, TtsEngineId, TtsLineResult, VoiceRef } from '@nobot/shared'
import { useState } from 'react'
import { usePreviewVoice, useTtsEngines, useTtsVoices } from '../../../api/tts'
import { PlayIcon, PlusIcon, StopIcon, XIcon } from '../../../components/icons'
import { controlClass, cx, IconButton, selectClass } from '../../../components/ui'
import { t } from '../../../i18n'
import { errorMessage, toast } from '../../../stores/toast'
import { audioEngine } from './engine'

/** 试听一个声音：browser 引擎在前端合成，其他引擎播放服务端缓存好的音频 */
export function playPreview(result: TtsLineResult) {
  if (result.kind === 'audio') return audioEngine.playVoice({ url: result.url })
  if (result.kind === 'browser')
    return audioEngine.playVoice({ browser: { voice: result.voice, speed: result.speed, text: result.text } })
  return Promise.resolve('stopped' as const)
}

/**
 * 声音选择器：引擎 + 声音 + 语速 + 试听，一行排开（窄时换行）。
 * value 为 null 表示「不设置」；allowNone 时第一个选项是「不设置」。
 * settings 传扩展设置的表单草稿，没保存的密钥和地址也能拉到声音列表。
 */
export function VoicePicker({
  value,
  onChange,
  allowNone = true,
  noneLabel,
  settings,
  disabled,
}: {
  value: VoiceRef | null
  onChange: (value: VoiceRef | null) => void
  allowNone?: boolean
  noneLabel?: string
  settings?: Record<string, unknown>
  disabled?: boolean
}) {
  const engines = useTtsEngines()
  const voices = useTtsVoices(value?.engine ?? 'browser', settings)
  const preview = usePreviewVoice()
  const [playing, setPlaying] = useState(false)
  const engine = engines.data?.find((e) => e.id === value?.engine)
  const options = value ? (voices.data ?? []) : []
  // 列表里没有当前值时（手动填的、或列表还没拉到）也要能显示出来
  const known = !value || options.some((o) => o.value === value.voice)

  const setEngine = (id: TtsEngineId | '') => {
    if (!id) return onChange(null)
    onChange({
      engine: id,
      voice: value?.engine === id ? value.voice : '',
      speed: value?.speed ?? 1,
      gender: value?.engine === id ? value.gender : undefined,
    })
  }
  const setVoice = (voice: string) =>
    value && onChange({ ...value, voice, gender: options.find((o) => o.value === voice)?.gender })
  const test = () => {
    if (!value?.voice) return
    if (playing) {
      audioEngine.stopVoice()
      return setPlaying(false)
    }
    setPlaying(true)
    preview.mutate(
      { voice: value },
      {
        onSuccess: (result) => void playPreview(result).finally(() => setPlaying(false)),
        onError: (e) => {
          setPlaying(false)
          toast.error(errorMessage(e))
        },
      },
    )
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <select
        className={cx(selectClass, 'h-8 w-36 pl-2.5 text-[13px]')}
        aria-label={t('朗读引擎')}
        disabled={disabled}
        value={value?.engine ?? ''}
        onChange={(e) => setEngine(e.target.value as TtsEngineId | '')}
      >
        {allowNone && <option value="">{noneLabel ?? t('不设置')}</option>}
        {engines.data?.map((e) => (
          <option key={e.id} value={e.id}>
            {e.configured ? e.label : t('{name}（未配置）', { name: e.label })}
          </option>
        ))}
      </select>
      {value && (
        <>
          {options.length > 0 ? (
            <select
              className={cx(selectClass, 'h-8 min-w-0 flex-1 basis-40 pl-2.5 text-[13px]')}
              aria-label={t('声音')}
              disabled={disabled}
              value={value.voice}
              onChange={(e) => setVoice(e.target.value)}
            >
              {!value.voice && <option value="">{t('选择声音…')}</option>}
              {!known && <option value={value.voice}>{value.voice}</option>}
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={cx(controlClass, 'h-8 min-w-0 flex-1 basis-40 px-2.5 text-[13px]')}
              aria-label={t('声音')}
              disabled={disabled}
              placeholder={voices.isLoading ? t('加载中…') : t('声音名称或 ID')}
              value={value.voice}
              onChange={(e) => setVoice(e.target.value)}
            />
          )}
          <label className="flex items-center gap-1 text-xs text-zinc-500" title={t('语速倍率')}>
            <span>{t('语速')}</span>
            <input
              type="number"
              min={0.5}
              max={2}
              step={0.1}
              disabled={disabled}
              className={cx(controlClass, 'h-8 w-16 px-2 text-center text-[13px] tabular-nums')}
              value={value.speed}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n)) onChange({ ...value, speed: Math.min(2, Math.max(0.5, n)) })
              }}
            />
          </label>
          <IconButton
            label={playing ? t('停止试听') : t('试听')}
            className="size-8"
            disabled={disabled || !value.voice || (engine && !engine.configured)}
            onClick={test}
          >
            {playing ? <StopIcon /> : <PlayIcon />}
          </IconButton>
        </>
      )}
      {value && engine?.delivery && <DeliveryBadges capabilities={engine.delivery} />}
      {voices.error && value && value.engine !== 'browser' && (
        <p className="basis-full text-xs text-red-600 dark:text-red-400">{errorMessage(voices.error)}</p>
      )}
    </div>
  )
}

/** 一组声音（NPC 声音池）：每行一个选择器，可以增删 */
export function VoiceListPicker({
  value,
  onChange,
  settings,
  disabled,
}: {
  value: VoiceRef[]
  onChange: (value: VoiceRef[]) => void
  settings?: Record<string, unknown>
  disabled?: boolean
}) {
  return (
    <div className="space-y-1.5">
      {value.map((voice, i) => (
        <div key={i} className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            <VoicePicker
              value={voice}
              allowNone={false}
              settings={settings}
              disabled={disabled}
              onChange={(next) => next && onChange(value.map((v, j) => (j === i ? next : v)))}
            />
          </div>
          {/* 声音的性别：按性别分配时用；自动则由服务端按引擎信息或名字判断 */}
          <select
            aria-label={t('声音性别')}
            className={cx(selectClass, 'h-8 w-20 shrink-0 pl-2 text-[12px]')}
            disabled={disabled}
            value={voice.gender ?? ''}
            onChange={(e) => {
              const g = e.target.value as Gender | ''
              const { gender: _, ...rest } = voice
              onChange(value.map((v, j) => (j === i ? (g ? { ...rest, gender: g } : rest) : v)))
            }}
          >
            <option value="">{t('自动')}</option>
            <option value="male">{t('男')}</option>
            <option value="female">{t('女')}</option>
            <option value="neutral">{t('中性')}</option>
          </select>
          <IconButton
            label={t('移除这个声音')}
            className="size-8"
            disabled={disabled}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <XIcon />
          </IconButton>
        </div>
      ))}
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange([...value, { engine: value.at(-1)?.engine ?? 'edge', voice: '', speed: 1 }])}
        className="flex h-8 items-center gap-1 rounded-lg px-2 text-[13px] text-violet-600 hover:bg-violet-50 disabled:opacity-50 dark:text-violet-400 dark:hover:bg-violet-950/40"
      >
        <PlusIcon width={15} height={15} />
        {t('添加声音')}
      </button>
    </div>
  )
}

/** 当前引擎（和模型）能怎么控制语气：用一排小标签说明，帮用户挑引擎 */
function DeliveryBadges({ capabilities: c }: { capabilities: DeliveryCapabilities }) {
  const emotion: Record<DeliveryCapabilities['emotion'], string> = {
    none: t('不支持语气'),
    enum: t('情绪参数'),
    instruction: t('自然语言指令'),
    'tags-free': t('文本标签（可自由描述）'),
    'tags-fixed': t('文本标签（固定几种）'),
    'ref-audio': t('按语气切参考音频'),
    prosody: t('只调语速、音调、音量'),
  }
  const badges = [
    emotion[c.emotion],
    c.intensity && t('强弱'),
    c.volume && t('耳语 / 喊叫'),
    c.direction && t('演绎说明'),
    c.cues.length > 0 && t('笑声、叹气等 {count} 种', { count: c.cues.length }),
  ].filter((b): b is string => !!b)
  return (
    <div className="flex basis-full flex-wrap items-center gap-1 text-[11px] text-zinc-500">
      <span>{t('语气控制：')}</span>
      {badges.map((b) => (
        <span
          key={b}
          className={cx(
            'rounded px-1.5 py-0.5',
            c.emotion === 'none'
              ? 'bg-zinc-100 dark:bg-zinc-800'
              : 'bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300',
          )}
        >
          {b}
        </span>
      ))}
    </div>
  )
}
