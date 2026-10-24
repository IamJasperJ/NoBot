import { z } from 'zod'
import { HttpError } from '../../../../errors'
import { t } from '../../../../i18n'
import type { TranscriptionResult } from '../../../types'
import { audioDuration } from './duration'
import { asrSettings } from './settings'

export const asrNetwork: { fetch?: typeof fetch } = {}
const formats: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
}
export async function transcribe(
  bytes: Uint8Array,
  mime: string,
  settings: Record<string, unknown>,
  opts: { language?: 'auto' | 'zh' | 'en'; durationMs?: number; signal?: AbortSignal } = {},
): Promise<TranscriptionResult> {
  const s = asrSettings.parse(settings)
  if (s.asrEngine === 'off') return { kind: 'unavailable', reason: 'asr-disabled' }
  const ext = formats[mime.toLowerCase().split(';')[0]!.trim()]
  if (!ext) throw new HttpError(400, 'BAD_AUDIO', t('不支持的音频格式'))
  if (!bytes.length) throw new HttpError(400, 'BAD_AUDIO', t('音频文件为空'))
  if (bytes.length > s.asrMaxSizeMb * 1024 * 1024)
    throw new HttpError(413, 'TOO_LARGE', t('文件太大（上限 {limit}MB）', { limit: s.asrMaxSizeMb }))
  const checkDuration = (ms?: number) => {
    if (ms !== undefined && (!Number.isFinite(ms) || ms < 0 || ms > s.asrMaxDuration * 1000))
      throw new HttpError(400, 'AUDIO_TOO_LONG', t('语音超过时长上限'))
  }
  checkDuration(opts.durationMs)
  const detectedDuration = await audioDuration(bytes)
  checkDuration(detectedDuration)
  opts.signal?.throwIfAborted()
  // ASR_FETCH_MOCK=1：与 TTS 离线开关一致，验收无需访问真实语音服务。
  if (process.env.ASR_FETCH_MOCK === '1' && !asrNetwork.fetch)
    return { kind: 'transcript', text: '这是一条测试语音。', language: 'zh', durationMs: 1000 }
  const form = new FormData()
  form.set('file', new Blob([new Uint8Array(bytes)], { type: mime }), `recording.${ext}`)
  form.set('model', s.asrModel)
  form.set('response_format', 'verbose_json')
  const language = opts.language ?? s.asrLanguage
  if (language !== 'auto') form.set('language', language)
  if (s.asrPrompt) form.set('prompt', s.asrPrompt)
  try {
    const response = await (asrNetwork.fetch ?? fetch)(`${s.asrBaseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST',
      body: form,
      headers: s.asrApiKey ? { Authorization: `Bearer ${s.asrApiKey}` } : {},
      signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
    })
    if (!response.ok) throw new Error()
    const result = z
      .object({
        text: z.string().trim().min(1),
        language: z.string().optional(),
        duration: z.number().nonnegative().optional(),
      })
      .parse(await response.json())
    const durationMs =
      detectedDuration ?? (result.duration === undefined ? undefined : Math.round(result.duration * 1000))
    if (durationMs === undefined)
      throw new HttpError(502, 'ASR_DURATION_UNKNOWN', t('无法确认音频时长，请使用支持时长信息的识别服务'))
    checkDuration(result.duration === undefined ? undefined : result.duration * 1000)
    checkDuration(durationMs)
    return { kind: 'transcript', text: result.text, language: result.language, durationMs }
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(502, 'ASR_FAILED', t('语音识别失败，请检查配置后重试'))
  }
}
