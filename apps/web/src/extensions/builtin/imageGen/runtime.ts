import type { AttachmentDTO, MessageDTO } from '@nobot/shared'
import { t } from '../../../i18n'
import type { ClientExtensionAPI } from '../../types'
import { errorText, type GalleryImage, imageModes, type Preview } from './shared'

export function createRuntime(api: ClientExtensionAPI) {
  const R = api.React
  const h = R.createElement
  async function request(path: string, body?: unknown) {
    const response = await api.fetchServer(
      path,
      body === undefined
        ? undefined
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    )
    const data = await response.json()
    if (!response.ok) throw new Error(data.error?.message ?? t('图片接口 HTTP {status}', { status: response.status }))
    return data as {
      message?: MessageDTO
      background?: unknown
      image?: AttachmentDTO
      durationMs?: number
      options?: { value: string; label: string }[]
      images?: GalleryImage[]
      total?: number
      error?: string
      placeholders?: { name: string; used: boolean }[]
      schedulers?: { value: string; label: string }[]
      adetailer?: boolean
      messageText?: string
    }
  }
  async function refresh(chatId: string, backgrounds = false) {
    await Promise.all([
      api.queryClient.invalidateQueries({ queryKey: ['chat', chatId] }),
      ...(backgrounds ? [api.queryClient.invalidateQueries({ queryKey: ['backgrounds'] })] : []),
    ])
  }
  const reviews = new Map<
    string,
    { chatId: string; preview: Preview; resolve: (value: { prompt: string; negative: string } | null) => void }
  >()
  const active = new Map<string, number>()
  const listeners = new Set<() => void>()
  function countRequest(chatId: string, delta: number) {
    active.set(chatId, (active.get(chatId) ?? 0) + delta)
    for (const listener of listeners) listener()
  }
  async function generate(chatId: string, mode: string, extra: Record<string, unknown> = {}) {
    const name = imageModes().find(([key]) => key === mode)?.[1] ?? mode
    countRequest(chatId, 1)
    try {
      const settings = await api.getSettings()
      if (settings.async === false || mode === 'background') api.toast.info(t('正在生成：{name}…', { name }))
      let confirmed: Record<string, unknown> = {}
      if (settings.editBeforeGenerate === true) {
        const response = await api.fetchServer('prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId, mode, ...extra }),
        })
        const preview = (await response.json()) as Preview & { error?: { message: string } }
        if (!response.ok) throw new Error(preview.error?.message ?? t('提示词预览失败'))
        const id = preview.snapshotId
        const edited = await new Promise<{ prompt: string; negative: string } | null>((resolve) => {
          reviews.set(id, { chatId, preview, resolve })
          for (const listener of listeners) listener()
        })
        reviews.delete(id)
        for (const listener of listeners) listener()
        if (!edited) return
        confirmed = { ...edited, snapshotId: id }
      }
      const data = await request('generate', { chatId, mode, ...extra, ...confirmed })
      if (data.background) api.toast.info(t('已生成背景并设为聊天背景'))
      await refresh(chatId, !!data.background)
    } catch (error) {
      api.toast.error(t('{name}生成失败：{error}', { name, error: errorText(error) }))
    } finally {
      countRequest(chatId, -1)
    }
  }
  return { api, R, h, request, refresh, reviews, active, listeners, generate }
}

export type ImageGenRuntime = ReturnType<typeof createRuntime>
