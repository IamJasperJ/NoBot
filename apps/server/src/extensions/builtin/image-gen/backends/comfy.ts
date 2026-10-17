import { HttpError } from '../../../../errors'
import { t } from '../../../../i18n'
import { comfyCapabilities, comfyHeaders } from '../discovery'
import type { Settings } from '../settings'
import { buildWorkflow } from '../workflow'
import { imageFetch, jsonResponse, object } from './http'

export async function comfyModels(settings: Settings) {
  return (await comfyCapabilities(settings)).models
}
export async function generateComfy(
  settings: Settings,
  prompt: string,
  width: number,
  height: number,
  abort?: AbortSignal,
): Promise<Uint8Array> {
  const base = settings.comfyUrl.replace(/\/+$/, '')
  const signal = AbortSignal.any([AbortSignal.timeout(settings.comfyTimeout * 1000), ...(abort ? [abort] : [])])
  const headers = comfyHeaders(settings)
  const posted = await jsonResponse(
    await imageFetch(`${base}/prompt`, {
      method: 'POST',
      signal,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: buildWorkflow(settings, prompt, width, height), client_id: crypto.randomUUID() }),
    }),
  )
  if (typeof posted.prompt_id !== 'string') throw new HttpError(502, 'COMFY_ID', t('ComfyUI 没有返回任务编号'))
  while (!signal.aborted) {
    const history = await jsonResponse(
      await imageFetch(`${base}/history/${encodeURIComponent(posted.prompt_id)}`, { signal, headers }),
    )
    const task = object(history[posted.prompt_id])
    if (object(task.status).status_str === 'error')
      throw new HttpError(
        502,
        'COMFY_FAILED',
        t('ComfyUI 执行失败：{error}', { error: JSON.stringify(task.status).slice(0, 200) }),
      )
    for (const output of Object.values(object(task.outputs))) {
      const images = object(output).images
      const image = object(Array.isArray(images) ? images[0] : undefined)
      if (typeof image.filename !== 'string') continue
      const params = new URLSearchParams({
        filename: image.filename,
        subfolder: String(image.subfolder ?? ''),
        type: String(image.type ?? 'output'),
      })
      return new Uint8Array(await (await imageFetch(`${base}/view?${params}`, { signal, headers })).arrayBuffer())
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', cancelWait)
        resolve()
      }, 1000)
      const cancelWait = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', cancelWait)
        reject(signal.reason)
      }
      signal.addEventListener('abort', cancelWait, { once: true })
      if (signal.aborted) cancelWait()
    })
  }
  throw new HttpError(502, 'COMFY_TIMEOUT', t('ComfyUI 生成超时'))
}
