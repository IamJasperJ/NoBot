import { HttpError } from '../../../../errors'
import { t } from '../../../../i18n'
import { getApiPresetRow } from '../../../../services/connections'
import { parseHeaders } from '../discovery'
import { settingsSchema } from '../settings'
import { imageFetch, jsonResponse, object } from './http'
import { aspectRatio } from './openai'
import { chatCapabilities, type ImageBackend } from './types'

export const openrouterHeaders = (settings: import('../settings').Settings) => {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${settings.openrouterApiKey}`,
  })
  for (const [key, value] of Object.entries(parseHeaders(settings.openrouterHeaders, 'OpenRouter ')))
    headers.set(key, value)
  return headers
}
export const openrouterBackend: ImageBackend = {
  id: 'openrouter',
  label: 'OpenRouter',
  get settingsSchema() {
    return settingsSchema.filter((field) => field.key.startsWith('openrouter'))
  },
  capabilities: chatCapabilities,
  promptStyle: () => 'natural',
  model: (settings) => settings.openrouterModel,
  resolveConnection(settings) {
    if (!settings.openrouterConnectionId) return settings
    const connection = getApiPresetRow(settings.openrouterConnectionId)
    const headers = new Headers(connection.headers)
    for (const [key, value] of Object.entries(parseHeaders(settings.openrouterHeaders, 'OpenRouter ')))
      headers.set(key, value)
    return {
      ...settings,
      openrouterBaseUrl: connection.baseUrl,
      openrouterApiKey: connection.apiKey,
      openrouterHeaders: JSON.stringify(Object.fromEntries(headers)),
    }
  },
  validate(settings) {
    if (!settings.openrouterBaseUrl.trim() || !settings.openrouterModel.trim())
      throw new HttpError(400, 'IMAGE_CONFIG', t('请先配置图片接口地址和模型'))
  },
  async discover(settings) {
    const body = await jsonResponse(
      await imageFetch(`${settings.openrouterBaseUrl.replace(/\/+$/, '')}/models`, {
        headers: openrouterHeaders(settings),
        signal: AbortSignal.timeout(30000),
      }),
    )
    return {
      models: (Array.isArray(body.data) ? body.data : []).flatMap((item) => {
        const model = object(item)
        const outputs = object(model.architecture).output_modalities
        return typeof model.id === 'string' && Array.isArray(outputs) && outputs.includes('image')
          ? [{ value: model.id, label: typeof model.name === 'string' ? model.name : model.id }]
          : []
      }),
    }
  },
  async test(settings) {
    await openrouterBackend.discover(settings)
  },
  async generate({ settings, prompt, width, height }, abort) {
    const signal = AbortSignal.any([AbortSignal.timeout(300000), ...(abort ? [abort] : [])])
    const body = await jsonResponse(
      await imageFetch(`${settings.openrouterBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: openrouterHeaders(settings),
        signal,
        body: JSON.stringify({
          model: settings.openrouterModel,
          modalities: ['image', 'text'],
          stream: false,
          messages: [{ role: 'user', content: prompt }],
          image_config: { aspect_ratio: aspectRatio(width, height) },
        }),
      }),
    )
    const images = object(object(Array.isArray(body.choices) ? body.choices[0] : undefined).message).images
    for (const image of Array.isArray(images) ? images : []) {
      const url = object(object(image).image_url).url
      const match = typeof url === 'string' ? url.match(/^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/) : null
      if (match) return { bytes: new Uint8Array(Buffer.from(match[2]!, 'base64')), mime: match[1]! }
    }
    throw new HttpError(502, 'IMAGE_EMPTY', t('图片接口没有返回图片'))
  },
}
