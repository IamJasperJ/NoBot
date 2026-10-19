import type { AudioKind, AudioTrackDTO } from '@nobot/shared'
import { useEffect, useRef, useState } from 'react'
import {
  useAudioTracks,
  useDeleteAudioTracks,
  useImportAudioUrl,
  useUpdateAudioTrack,
  useUploadAudioTrack,
} from '../../../api/audio'
import { SelectField, TextAreaField, TextField } from '../../../components/form'
import {
  EditIcon,
  LinkIcon,
  MusicIcon,
  PauseIcon,
  PlayIcon,
  SearchIcon,
  TrashIcon,
  UploadIcon,
} from '../../../components/icons'
import { Menu, MenuEntry } from '../../../components/menu'
import { Button, controlClass, cx, Dialog, IconButton } from '../../../components/ui'
import { t } from '../../../i18n'
import { errorMessage, toast } from '../../../stores/toast'

const kindLabel = (kind: AudioKind) => (kind === 'bgm' ? t('背景音乐') : t('音效'))
const kindOptions = () => [
  { value: 'bgm' as const, label: t('背景音乐') },
  { value: 'sfx' as const, label: t('音效') },
]

/** 1:05 这样的时长；读不到时长时显示「—」 */
const duration = (ms: number | null) => {
  if (ms === null) return '—'
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const size = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

/**
 * 音频扩展的「音频库」页面（扩展页里的标签）：
 * 按种类筛选和搜索；上传（可多选）或从网址导入；每行可以试听、改名改描述改种类、删除。
 * 模型在 VN 里用 <bgm name> / <sfx name> 按名字挑曲目，所以名字写清楚场景或情绪最好用。
 */
export function AudioLibraryPage() {
  const tracks = useAudioTracks()
  const upload = useUploadAudioTrack()
  const importUrl = useImportAudioUrl()
  const update = useUpdateAudioTrack()
  const remove = useDeleteAudioTracks()
  const [kind, setKind] = useState<AudioKind | 'all'>('all')
  const [search, setSearch] = useState('')
  const [uploading, setUploading] = useState(false)
  const [importing, setImporting] = useState<{ url: string; name: string; kind: AudioKind } | null>(null)
  const [editing, setEditing] = useState<{
    id: string
    name: string
    description: string
    kind: AudioKind
  } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const preview = usePreview()

  const keyword = search.trim().toLocaleLowerCase()
  const list = (tracks.data ?? [])
    .filter((track) => kind === 'all' || track.kind === kind)
    .filter((track) => `${track.name} ${track.description}`.toLocaleLowerCase().includes(keyword))
  const counts = {
    all: tracks.data?.length ?? 0,
    bgm: tracks.data?.filter((track) => track.kind === 'bgm').length ?? 0,
    sfx: tracks.data?.filter((track) => track.kind === 'sfx').length ?? 0,
  }
  const onError = (e: unknown) => toast.error(errorMessage(e))
  // 上传按当前筛选的种类归类；「全部」时当作背景音乐
  const uploadKind: AudioKind = kind === 'all' ? 'bgm' : kind

  const uploadFiles = async (files: File[]) => {
    setUploading(true)
    let done = 0
    for (const file of files) {
      try {
        await upload.mutateAsync({ file, kind: uploadKind })
        done++
      } catch (e) {
        toast.error(t('{name}：{error}', { name: file.name, error: errorMessage(e) }))
      }
    }
    setUploading(false)
    if (done) toast.info(t('已添加 {count} 个音频', { count: done }))
  }

  return (
    <div className="mx-auto flex max-w-4xl min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg bg-zinc-100 p-0.5 text-[13px] dark:bg-zinc-800">
          {(['all', 'bgm', 'sfx'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={kind === value}
              onClick={() => setKind(value)}
              className={cx(
                'h-8 rounded-md px-3 whitespace-nowrap',
                kind === value
                  ? 'bg-white font-medium shadow-sm dark:bg-zinc-900'
                  : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200',
              )}
            >
              {value === 'all' ? t('全部') : kindLabel(value)}
              <span className="ml-1 text-xs tabular-nums opacity-60">{counts[value]}</span>
            </button>
          ))}
        </div>
        <label className="relative min-w-40 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-zinc-400" />
          <input
            className={cx(controlClass, 'h-9 w-full pl-8 text-[13px]')}
            placeholder={t('搜索名字或描述')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <IconButton
          label={t('从网址添加')}
          disabled={uploading}
          onClick={() => setImporting({ url: '', name: '', kind: uploadKind })}
        >
          <LinkIcon />
        </IconButton>
        <Button size="sm" variant="primary" disabled={uploading} onClick={() => input.current?.click()}>
          <UploadIcon />
          {uploading ? t('上传中…') : t('上传')}
        </Button>
        <input
          ref={input}
          type="file"
          accept="audio/*,.mp3,.ogg,.wav,.m4a,.flac,.webm"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            if (files.length) void uploadFiles(files)
          }}
        />
      </div>

      <p className="text-xs text-zinc-500">
        {t(
          'VN 里模型用 <bgm name="名字"> 切换背景音乐、用 <sfx name="名字"> 播放音效，按名字匹配。名字写清楚场景或情绪最好用，比如「酒馆夜晚」「紧张战斗」「开门」。',
        )}
      </p>

      {tracks.isLoading ? (
        <p className="py-10 text-center text-sm text-zinc-500">{t('加载中…')}</p>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-300 py-12 text-center dark:border-zinc-700">
          <MusicIcon className="size-8 text-zinc-300 dark:text-zinc-600" />
          <p className="text-sm text-zinc-500">
            {counts.all ? t('没有符合条件的音频') : t('音频库还是空的，上传一些背景音乐和音效吧')}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {list.map((track) => (
            <TrackRow
              key={track.id}
              track={track}
              playing={preview.playing === track.id}
              onToggle={() => preview.toggle(track)}
              onEdit={() =>
                setEditing({ id: track.id, name: track.name, description: track.description, kind: track.kind })
              }
              onDelete={() => {
                if (!confirm(t('删除「{name}」？', { name: track.name }))) return
                if (preview.playing === track.id) preview.stop()
                remove.mutate([track.id], { onError })
              }}
            />
          ))}
        </ul>
      )}

      <Dialog open={!!editing} onClose={() => setEditing(null)} title={t('编辑音频')}>
        {editing && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              if (!editing.name.trim()) return
              update.mutate(
                {
                  id: editing.id,
                  input: { name: editing.name.trim(), description: editing.description.trim(), kind: editing.kind },
                },
                { onError, onSuccess: () => setEditing(null) },
              )
            }}
          >
            <TextField
              label={t('名字')}
              hint={t('模型按名字挑选，写场景或情绪最好用')}
              value={editing.name}
              onChange={(name) => setEditing({ ...editing, name })}
            />
            <SelectField
              label={t('种类')}
              value={editing.kind}
              options={kindOptions()}
              onChange={(value) => setEditing({ ...editing, kind: value })}
            />
            <TextAreaField
              label={t('描述')}
              hint={t('风格、情绪、适合的场景，方便自己查找')}
              rows={3}
              value={editing.description}
              onChange={(description) => setEditing({ ...editing, description })}
            />
            <Button type="submit" variant="primary" disabled={update.isPending || !editing.name.trim()}>
              {t('保存')}
            </Button>
          </form>
        )}
      </Dialog>

      <Dialog open={!!importing} onClose={() => setImporting(null)} title={t('从网址添加音频')}>
        {importing && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              if (!importing.url.trim()) return
              importUrl.mutate(
                { url: importing.url.trim(), name: importing.name.trim() || undefined, kind: importing.kind },
                {
                  onError,
                  onSuccess: () => {
                    toast.info(t('已添加 {count} 个音频', { count: 1 }))
                    setImporting(null)
                  },
                },
              )
            }}
          >
            <TextField
              label={t('网址')}
              placeholder="https://…/music.mp3"
              value={importing.url}
              onChange={(url) => setImporting({ ...importing, url })}
            />
            <TextField
              label={t('名字')}
              hint={t('留空使用文件名')}
              value={importing.name}
              onChange={(name) => setImporting({ ...importing, name })}
            />
            <SelectField
              label={t('种类')}
              value={importing.kind}
              options={kindOptions()}
              onChange={(value) => setImporting({ ...importing, kind: value })}
            />
            <Button type="submit" variant="primary" disabled={importUrl.isPending || !importing.url.trim()}>
              {importUrl.isPending ? t('下载中…') : t('添加')}
            </Button>
          </form>
        )}
      </Dialog>
    </div>
  )
}

function TrackRow({
  track,
  playing,
  onToggle,
  onEdit,
  onDelete,
}: {
  track: AudioTrackDTO
  playing: boolean
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <li className={cx('flex items-center gap-3 px-3 py-2', playing && 'bg-violet-50/70 dark:bg-violet-950/30')}>
      <button
        type="button"
        onClick={onToggle}
        aria-label={playing ? t('停止试听') : t('试听')}
        title={playing ? t('停止试听') : t('试听')}
        className={cx(
          'flex size-9 shrink-0 items-center justify-center rounded-full [&_svg]:size-4',
          playing
            ? 'bg-violet-600 text-white'
            : 'bg-zinc-100 text-zinc-600 hover:bg-violet-100 hover:text-violet-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-violet-950',
        )}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{track.name}</span>
          <span
            className={cx(
              'shrink-0 rounded px-1.5 py-px text-[10px] font-medium',
              track.kind === 'bgm'
                ? 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300'
                : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
            )}
          >
            {kindLabel(track.kind)}
          </span>
        </div>
        {track.description && <p className="truncate text-xs text-zinc-500">{track.description}</p>}
      </div>
      <span className="hidden shrink-0 text-xs text-zinc-400 tabular-nums sm:block">
        {duration(track.durationMs)} · {size(track.size)}
      </span>
      <Menu>
        <MenuEntry icon={<EditIcon />} onClick={onEdit}>
          {t('编辑')}
        </MenuEntry>
        <MenuEntry icon={<TrashIcon />} danger onClick={onDelete}>
          {t('删除')}
        </MenuEntry>
      </Menu>
    </li>
  )
}

/** 列表试听：同一时间只放一首，离开页面时停止 */
function usePreview() {
  const audio = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const stop = () => {
    audio.current?.pause()
    audio.current = null
    setPlaying(null)
  }
  useEffect(() => () => audio.current?.pause(), [])
  const toggle = (track: AudioTrackDTO) => {
    if (playing === track.id) return stop()
    audio.current?.pause()
    const el = new Audio(track.url)
    el.onended = () => setPlaying((id) => (id === track.id ? null : id))
    audio.current = el
    setPlaying(track.id)
    el.play().catch((e: unknown) => {
      setPlaying(null)
      toast.error(errorMessage(e))
    })
  }
  return { playing, toggle, stop }
}
