import type { AudioKind, AudioTrackDTO, importAudioUrlInput, updateAudioTrackInput } from '@nobot/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { readError } from './client'

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const form = body instanceof FormData
  const response = await fetch(`/api/ext/audio${path}`, {
    method,
    headers: body !== undefined && !form ? { 'Content-Type': 'application/json' } : undefined,
    body: form ? body : body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw await readError(response)
  return response.json() as Promise<T>
}

/** 元数据读取失败不阻塞上传；始终释放临时地址与媒体资源。 */
export function readAudioDuration(file: File): Promise<number | undefined> {
  return new Promise((resolve) => {
    const audio = document.createElement('audio')
    const url = URL.createObjectURL(file)
    const finish = (duration?: number) => {
      clearTimeout(timer)
      audio.onloadedmetadata = null
      audio.onerror = null
      audio.removeAttribute('src')
      audio.load()
      URL.revokeObjectURL(url)
      resolve(duration)
    }
    const timer = setTimeout(() => finish(), 3000)
    audio.onloadedmetadata = () =>
      finish(Number.isFinite(audio.duration) && audio.duration >= 0 ? Math.round(audio.duration * 1000) : undefined)
    audio.onerror = () => finish()
    audio.preload = 'metadata'
    audio.src = url
  })
}
export interface UploadAudioInput {
  file: File
  name?: string
  kind?: AudioKind
  description?: string
}
export const audioApi = {
  list: (kind?: AudioKind) => request<AudioTrackDTO[]>('GET', `/tracks${kind ? `?kind=${kind}` : ''}`),
  upload: async ({ file, ...data }: UploadAudioInput) => {
    const duration = await readAudioDuration(file).catch(() => undefined)
    const form = new FormData()
    form.set('file', file)
    for (const [key, value] of Object.entries(data)) if (value !== undefined) form.set(key, value)
    if (duration !== undefined) form.set('durationMs', String(duration))
    return request<AudioTrackDTO>('POST', '/tracks', form)
  },
  importUrl: (input: Omit<ReturnType<typeof importAudioUrlInput.parse>, 'kind'> & { kind?: AudioKind }) =>
    request<AudioTrackDTO>('POST', '/tracks/import-url', input),
  update: ({ id, input }: { id: string; input: ReturnType<typeof updateAudioTrackInput.parse> }) =>
    request<AudioTrackDTO>('PATCH', `/tracks/${encodeURIComponent(id)}`, input),
  remove: (id: string) => request<{ ok: true }>('DELETE', `/tracks/${encodeURIComponent(id)}`),
  batchRemove: (ids: string[]) => request<{ ok: true }>('POST', '/tracks/batch-delete', { ids }),
}
export const audioTracksKey = (kind?: AudioKind) =>
  kind ? (['audioTracks', kind] as const) : (['audioTracks'] as const)
export function useAudioTracks(kind?: AudioKind) {
  return useQuery({ queryKey: audioTracksKey(kind), queryFn: () => audioApi.list(kind) })
}
function useAudioMutation<T, R>(mutationFn: (input: T) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({ mutationFn, onSuccess: () => qc.invalidateQueries({ queryKey: ['audioTracks'] }) })
}
export const useUploadAudioTrack = () => useAudioMutation(audioApi.upload)
export const useImportAudioUrl = () => useAudioMutation(audioApi.importUrl)
export const useUpdateAudioTrack = () => useAudioMutation(audioApi.update)
export const useDeleteAudioTracks = () => useAudioMutation(audioApi.batchRemove)
