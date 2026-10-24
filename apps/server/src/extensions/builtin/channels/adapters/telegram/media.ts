import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { getSetting, setSetting } from '../../../../../db/client'
import { paths } from '../../../../../env'
import { HttpError } from '../../../../../errors'
import { t } from '../../../../../i18n'
import { type TelegramClient, TelegramError } from './client'

let ffmpegPath: string | null | undefined
export function detectFfmpeg() {
  if (ffmpegPath === undefined) ffmpegPath = Bun.which('ffmpeg')
  return ffmpegPath
}
export interface PreparedAudio {
  bytes: Uint8Array
  mime: string
  method: 'sendVoice' | 'sendAudio'
  filename: string
}
/** 子进程异步转换，输入输出落临时目录，避免管道背压和超大音频阻塞事件循环。 */
export async function prepareAudio(
  bytes: Uint8Array,
  mime: string,
  opts: {
    detect?: () => string | null
    convert?: (input: string, output: string, command: string) => Promise<void>
  } = {},
): Promise<PreparedAudio> {
  if (mime === 'audio/opus' || (mime === 'audio/ogg' && Buffer.from(bytes).includes(Buffer.from('OpusHead'))))
    return { bytes, mime: 'audio/ogg', method: 'sendVoice', filename: 'voice.ogg' }
  const command = (opts.detect ?? detectFfmpeg)()
  if (command) {
    const directory = await mkdtemp(join(tmpdir(), 'nobot-voice-'))
    try {
      const input = join(directory, 'input'),
        output = join(directory, 'voice.ogg')
      await Bun.write(input, bytes)
      if (opts.convert) await opts.convert(input, output, command)
      else {
        const child = Bun.spawn(
          [
            command,
            '-nostdin',
            '-v',
            'error',
            '-y',
            '-i',
            input,
            '-vn',
            '-ac',
            '1',
            '-ar',
            '48000',
            '-c:a',
            'libopus',
            '-b:a',
            '40k',
            output,
          ],
          { stdout: 'ignore', stderr: 'ignore' },
        )
        const timeout = setTimeout(() => child.kill(), 120000)
        try {
          if ((await child.exited) !== 0) throw new Error('convert')
        } finally {
          clearTimeout(timeout)
        }
      }
      return {
        bytes: new Uint8Array(await Bun.file(output).arrayBuffer()),
        mime: 'audio/ogg',
        method: 'sendVoice',
        filename: 'voice.ogg',
      }
    } catch {
      // 转码失败仍可发送原始文件，不影响文字和其余媒体。
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
  const voice = ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a'].includes(mime)
  return {
    bytes,
    mime,
    method: voice ? 'sendVoice' : 'sendAudio',
    filename:
      mime === 'audio/wav' ? 'voice.wav' : mime.includes('mp4') || mime.includes('m4a') ? 'voice.m4a' : 'voice.mp3',
  }
}

/** 只读取当前用户的已知资源目录；模型或消息中的任意 URL 不得变成服务器文件读取。 */
export async function readMediaAsset(url: string) {
  const parsed = new URL(url, 'http://asset')
  if (parsed.origin !== 'http://asset') return null
  const match = /^\/api\/assets\/(attachments|sprites|backgrounds|avatars|tts-cache)\/(.+)$/.exec(
    decodeURIComponent(parsed.pathname),
  )
  if (!match) return null
  const directories = {
    attachments: paths.attachments,
    sprites: paths.sprites,
    backgrounds: paths.backgrounds,
    avatars: paths.avatars,
    'tts-cache': paths.ttsCache,
  }
  const root = directories[match[1] as keyof typeof directories]
  const path = resolve(root, match[2]!)
  if (!path.startsWith(`${resolve(root)}${sep}`)) return null
  const file = Bun.file(path)
  if (!(await file.exists()) || file.size > 50 * 1024 * 1024) return null
  return { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type, filename: basename(path) }
}

export async function sendCachedMedia(
  client: TelegramClient,
  accountId: string,
  chat: string,
  method: 'sendPhoto' | 'sendDocument' | 'sendVoice' | 'sendAudio',
  asset: { bytes: Uint8Array; mime: string; filename: string },
  params: Record<string, unknown> = {},
) {
  const field = { sendPhoto: 'photo', sendDocument: 'document', sendVoice: 'voice', sendAudio: 'audio' }[method]
  // 文档、照片和语音的 file_id 不能互换；账号和内容哈希共同隔离缓存。
  const key = `channels:media:${accountId}:${method}:${createHash('sha256').update(asset.bytes).digest('hex')}`
  const cached = getSetting<string>(key)
  const upload = async (fileId?: string) => {
    if (fileId) return client.call<Record<string, unknown>>(method, { ...params, chat_id: chat, [field]: fileId })
    const form = new FormData()
    for (const [key, value] of Object.entries({ ...params, chat_id: chat }))
      if (value !== undefined) form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
    form.set(field, new Blob([new Uint8Array(asset.bytes)], { type: asset.mime }), asset.filename)
    return client.call<Record<string, unknown>>(method, form)
  }
  const result = await client.serialized(chat, async () => {
    try {
      return await upload(cached)
    } catch (error) {
      if (!cached || !(error instanceof TelegramError) || error.code !== 400) throw error
      return upload()
    }
  })
  const value = result[field]
  const file = Array.isArray(value) ? value.at(-1) : value
  if (file && typeof file === 'object' && 'file_id' in file && typeof file.file_id === 'string')
    setSetting(key, file.file_id)
  return result
}

export async function downloadTelegramFile(client: TelegramClient, media: { file_id?: string; file_size?: number }) {
  const limit = 20 * 1024 * 1024
  if (!media.file_id) throw new HttpError(400, 'BAD_MEDIA', t('无法下载媒体文件'))
  if ((media.file_size ?? 0) > limit)
    throw new HttpError(413, 'TOO_LARGE', t('文件太大（上限 {limit}MB）', { limit: 20 }))
  const result = await client.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: media.file_id })
  if (!result.file_path || (result.file_size ?? 0) > limit) throw new HttpError(400, 'BAD_MEDIA', t('无法下载媒体文件'))
  return client.downloadFile(result.file_path, limit)
}
