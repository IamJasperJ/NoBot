import type { FishVoiceItem } from '@nobot/shared'
import { useEffect, useRef, useState } from 'react'
import { useFishVoiceSearch, useRefreshFishVoices } from '../../../api/tts'
import { PauseIcon, PlayIcon, PlusIcon, RefreshIcon, SearchIcon, StarIcon } from '../../../components/icons'
import { Button, controlClass, cx, IconButton, selectClass } from '../../../components/ui'
import { t } from '../../../i18n'
import { errorMessage, toast } from '../../../stores/toast'
import type { SlotProps } from '../../types'

type SavedVoice = { id: string; name: string }
const asSaved = (value: unknown): SavedVoice[] =>
  Array.isArray(value)
    ? value.flatMap((v) =>
        v && typeof v === 'object' && typeof (v as SavedVoice).id === 'string'
          ? [{ id: (v as SavedVoice).id, name: String((v as SavedVoice).name ?? '') }]
          : [],
      )
    : []

/** 试听用的单个播放器：同一时间只放一条样音 */
function useSamplePlayer() {
  const audio = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  useEffect(() => () => audio.current?.pause(), [])
  const toggle = (id: string, url: string) => {
    audio.current?.pause()
    if (playing === id) {
      setPlaying(null)
      return
    }
    const el = new Audio(url)
    audio.current = el
    el.onended = () => setPlaying((p) => (p === id ? null : p))
    el.play().then(
      () => setPlaying(id),
      () => toast.error(t('样音播放失败')),
    )
  }
  return { playing, toggle }
}

/**
 * 「音频」扩展设置里 Fish Audio 分组下的声音搜索：按名字和语言搜 Fish Audio 的声音库（或只看自己的），
 * 试听样音，一键加进「自定义声音」。已收藏的排在前面并标星。改的是设置草稿，记得保存。
 */
export function FishVoiceSearch(props: SlotProps['extensions.settings.field']) {
  const { settings, onSettingsChange, disabled } = props
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [language, setLanguage] = useState('')
  const [self, setSelf] = useState(false)
  const [page, setPage] = useState(1)
  const hasKey = typeof settings.fishApiKey === 'string' && settings.fishApiKey.trim() !== ''
  const search = useFishVoiceSearch({ query, language, self, page }, settings, hasKey)
  const refresh = useRefreshFishVoices()
  const sample = useSamplePlayer()
  const saved = asSaved(settings.fishVoices)

  // 输入停 400ms 再搜，换条件回到第一页
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(input.trim())
      setPage(1)
    }, 400)
    return () => clearTimeout(timer)
  }, [input])

  const add = (item: FishVoiceItem) =>
    onSettingsChange({ ...settings, fishVoices: [...saved, { id: item.id, name: item.title }] })

  const languages = [
    { value: '', label: t('全部语言') },
    { value: 'zh', label: t('汉语') },
    { value: 'en', label: t('英文') },
    { value: 'ja', label: t('日文') },
  ]
  const items = search.data?.items ?? []

  return (
    <div className="space-y-2 py-1">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[13px] font-medium">{props.label}</div>
          <div className="text-xs text-zinc-500">
            {t('你自己的声音会自动出现在声音选择里；公开声音搜到后点「添加」，保存设置后就能选。')}
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || !hasKey || refresh.isPending}
          title={t('重新拉取你自己的声音')}
          onClick={() =>
            refresh.mutate(undefined, {
              onSuccess: () => toast.info(t('已刷新我的声音')),
              onError: (e) => toast.error(errorMessage(e)),
            })
          }
        >
          <RefreshIcon className={refresh.isPending ? 'animate-spin' : undefined} />
          {t('刷新我的声音')}
        </Button>
      </div>

      {!hasKey ? (
        <p className="rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-500 dark:bg-zinc-900">
          {t('先在上面填写 Fish Audio 密钥，才能搜索声音。')}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="relative min-w-40 flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-zinc-400" />
              <input
                className={cx(controlClass, 'h-8 w-full pr-2.5 pl-8 text-[13px]')}
                placeholder={t('按名字搜索声音')}
                value={input}
                disabled={disabled}
                onChange={(e) => setInput(e.target.value)}
              />
            </div>
            <select
              aria-label={t('语言')}
              className={cx(selectClass, 'h-8 w-28 pl-2.5 text-[13px]')}
              value={language}
              disabled={disabled}
              onChange={(e) => {
                setLanguage(e.target.value)
                setPage(1)
              }}
            >
              {languages.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
            <label className="flex h-8 items-center gap-1.5 px-1 text-[13px]">
              <input
                type="checkbox"
                checked={self}
                disabled={disabled}
                onChange={(e) => {
                  setSelf(e.target.checked)
                  setPage(1)
                }}
              />
              {t('只看我的')}
            </label>
          </div>

          <div className="max-h-80 divide-y divide-zinc-100 overflow-y-auto rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {search.isPending && <p className="px-3 py-4 text-center text-xs text-zinc-500">{t('搜索中…')}</p>}
            {search.error && <p className="px-3 py-4 text-center text-xs text-red-600">{errorMessage(search.error)}</p>}
            {!search.isPending && !search.error && items.length === 0 && (
              <p className="px-3 py-4 text-center text-xs text-zinc-500">{t('没有找到声音')}</p>
            )}
            {items.map((item) => {
              const added = saved.some((v) => v.id === item.id)
              return (
                <div key={item.id} className="flex items-center gap-2.5 px-2.5 py-2">
                  {item.coverUrl ? (
                    <img
                      src={item.coverUrl}
                      alt=""
                      loading="lazy"
                      className="size-9 shrink-0 rounded-md object-cover"
                    />
                  ) : (
                    <span className="size-9 shrink-0 rounded-md bg-zinc-100 dark:bg-zinc-800" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      {(item.marked || item.liked) && (
                        <StarIcon
                          aria-label={item.marked ? t('已收藏') : t('已点赞')}
                          className="size-3.5 shrink-0 fill-amber-400 text-amber-400"
                        />
                      )}
                      <span className="truncate text-[13px] font-medium" title={item.description || item.title}>
                        {item.title}
                      </span>
                    </div>
                    <div className="truncate text-[11px] text-zinc-500">
                      {[item.author, item.languages.join(' / ')].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  {item.sampleUrl && (
                    <IconButton
                      label={sample.playing === item.id ? t('停止试听') : t('试听')}
                      className="size-8 shrink-0"
                      onClick={() => item.sampleUrl && sample.toggle(item.id, item.sampleUrl)}
                    >
                      {sample.playing === item.id ? <PauseIcon /> : <PlayIcon />}
                    </IconButton>
                  )}
                  <Button size="sm" disabled={disabled || added} onClick={() => add(item)}>
                    {added ? (
                      t('已添加')
                    ) : (
                      <>
                        <PlusIcon />
                        {t('添加')}
                      </>
                    )}
                  </Button>
                </div>
              )
            })}
          </div>

          {(page > 1 || search.data?.hasMore) && (
            <div className="flex items-center justify-end gap-2 text-xs text-zinc-500">
              <span>{t('第 {page} 页', { page })}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={page <= 1 || search.isFetching}
                onClick={() => setPage(page - 1)}
              >
                {t('上一页')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!search.data?.hasMore || search.isFetching}
                onClick={() => setPage(page + 1)}
              >
                {t('下一页')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
