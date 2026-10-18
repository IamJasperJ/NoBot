import { HttpError } from '../../../../errors'
import { t } from '../../../../i18n'
import { type Settings, settingsSchema } from '../settings'
import { imageFetch, jsonResponse, object } from './http'
import { diffusionCapabilities, type ImageBackend, imageMime } from './types'

export function a1111Headers(settings: Settings) {
  return {
    'Content-Type': 'application/json',
    ...(settings.a1111Auth ? { Authorization: `Basic ${Buffer.from(settings.a1111Auth).toString('base64')}` } : {}),
  }
}
export function a1111Body(settings: Settings, prompt: string, width: number, height: number) {
  return {
    prompt,
    negative_prompt: settings.negativePrompt ?? '',
    width,
    height,
    seed: settings.seed,
    steps: settings.a1111Steps,
    cfg_scale: settings.a1111Cfg,
    sampler_name: settings.a1111Sampler,
    ...(settings.a1111Scheduler ? { scheduler: settings.a1111Scheduler } : {}),
    override_settings: {
      ...(settings.a1111Model ? { sd_model_checkpoint: settings.a1111Model } : {}),
      ...(settings.a1111Vae ? { sd_vae: settings.a1111Vae, forge_additional_modules: [settings.a1111Vae] } : {}),
      CLIP_stop_at_last_layers: settings.a1111ClipSkip,
    },
    override_settings_restore_afterwards: true,
    restore_faces: settings.a1111RestoreFaces,
    enable_hr: settings.a1111Hires,
    ...(settings.a1111Hires
      ? {
          hr_upscaler: settings.a1111Upscaler,
          hr_scale: settings.a1111HiresScale,
          hr_second_pass_steps: settings.a1111HiresSteps,
          denoising_strength: settings.a1111Denoise,
        }
      : {}),
    ...(settings.a1111ADetailer
      ? { alwayson_scripts: { ADetailer: { args: [true, true, { ad_model: 'face_yolov8n.pt' }] } } }
      : {}),
    send_images: true,
  }
}
export const a1111Backend: ImageBackend = {
  id: 'a1111',
  label: 'A1111 / Forge',
  get settingsSchema() {
    return settingsSchema.filter((field) => field.key.startsWith('a1111'))
  },
  capabilities: diffusionCapabilities,
  promptStyle: () => 'tags',
  model: (settings) => settings.a1111Model,
  validate(settings) {
    if (!settings.a1111Url.trim()) throw new HttpError(400, 'IMAGE_CONFIG', t('请先配置 A1111 / Forge 地址'))
  },
  async discover(settings) {
    const base = settings.a1111Url.replace(/\/+$/, '')
    const get = async (path: string, optional = false): Promise<unknown> => {
      try {
        return await (
          await imageFetch(`${base}${path}`, {
            headers: a1111Headers(settings),
            signal: AbortSignal.timeout(30000),
          })
        ).json()
      } catch (error) {
        // 老版本没有调度器或插件端点，只允许缺失路由；鉴权和网络错误仍需报告。
        if (optional && error instanceof HttpError && /HTTP (404|405)\b/.test(error.message)) return null
        throw error
      }
    }
    const [models, samplers, schedulers, vaes, upscalers, scripts] = await Promise.all([
      get('/sdapi/v1/sd-models'),
      get('/sdapi/v1/samplers'),
      get('/sdapi/v1/schedulers', true),
      get('/sdapi/v1/sd-vae'),
      get('/sdapi/v1/upscalers'),
      get('/sdapi/v1/scripts', true),
    ])
    const options = (items: unknown, key: string) =>
      (Array.isArray(items) ? items : []).flatMap((item) => {
        const value = object(item)[key]
        return typeof value === 'string' ? [{ value, label: value }] : []
      })
    const scriptNames = Object.values(object(scripts)).flatMap((value) => (Array.isArray(value) ? value : []))
    let adetailer = scriptNames.some((name) => typeof name === 'string' && /adetailer/i.test(name))
    if (!adetailer) adetailer = !!object(await get('/adetailer/v1/version', true)).version
    return {
      models: options(models, 'title'),
      samplers: options(samplers, 'name'),
      schedulers: options(schedulers, 'name'),
      vaes: options(vaes, 'model_name'),
      upscalers: options(upscalers, 'name'),
      adetailer,
    }
  },
  async test(settings) {
    await jsonResponse(
      await imageFetch(`${settings.a1111Url.replace(/\/+$/, '')}/sdapi/v1/options`, {
        headers: a1111Headers(settings),
        signal: AbortSignal.timeout(30000),
      }),
    )
  },
  async generate({ settings, prompt, width, height }, abort) {
    const body = await jsonResponse(
      await imageFetch(`${settings.a1111Url.replace(/\/+$/, '')}/sdapi/v1/txt2img`, {
        method: 'POST',
        headers: a1111Headers(settings),
        signal: AbortSignal.any([AbortSignal.timeout(300000), ...(abort ? [abort] : [])]),
        body: JSON.stringify(a1111Body(settings, prompt, width, height)),
      }),
    )
    const image = Array.isArray(body.images) ? body.images[0] : undefined
    if (typeof image !== 'string' || !image) throw new HttpError(502, 'IMAGE_EMPTY', t('图片接口没有返回图片'))
    const bytes = new Uint8Array(Buffer.from(image.replace(/^data:image\/[^;]+;base64,/, ''), 'base64'))
    let seed = settings.seed
    try {
      const info = object(typeof body.info === 'string' ? JSON.parse(body.info) : body.info)
      if (typeof info.seed === 'number') seed = info.seed
    } catch {
      /* 部分后端不返回有效的任务信息，保留请求种子。 */
    }
    return { bytes, mime: imageMime(bytes), seed }
  },
}
