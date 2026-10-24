import { createHash } from 'node:crypto'
import { parseStageMessage, pickSprite } from '@nobot/core/stage'
import type { ChannelBindingDTO, ChannelSettings, MessageDTO } from '@nobot/shared'
import sharp from 'sharp'
import { getSetting, setSetting } from '../../../db/client'
import { backgroundsForChat } from '../../../services/backgrounds/backgrounds'
import { matchStageMember, stageMembers } from '../../../services/generation/stage'
import { listSprites } from '../../../services/sprites/sprites'
import type { ExtensionHost } from '../../types'
import { OneBotClient } from './adapters/onebot11/client'
import { prepareAudio, readMediaAsset, sendCachedMedia } from './adapters/telegram/media'
import { escapeHtml } from './adapters/telegram/render'
import type { ChannelClient } from './adapters/types'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class OutboundMedia {
  constructor(
    readonly host: ExtensionHost,
    readonly log: (account: string, code: string) => void,
  ) {}
  async speak(
    binding: ChannelBindingDTO,
    message: MessageDTO,
    client: ChannelClient,
    accountId: string,
    native = false,
  ) {
    try {
      await client.serialized(binding.chat, () =>
        client.call('sendChatAction', {
          chat_id: binding.chat,
          message_thread_id: binding.thread || undefined,
          action: 'record_voice',
        }),
      )
      const result = await this.host.synthesizeSpeech(binding.chatId, message.id)
      if (result.kind !== 'audio') {
        this.log(accountId, `media.voice.${result.reason}`)
        return
      }
      for (const file of result.files) {
        const bytes = new Uint8Array(await Bun.file(file.path).arrayBuffer())
        // NapCat 自带 silk/ffmpeg 转码，不需要 NoBot 重复转换。
        // https://napneko.github.io/develop/file
        const prepared =
          client instanceof OneBotClient
            ? { bytes, mime: file.mime, method: 'sendVoice' as const, filename: 'voice.mp3' }
            : await prepareAudio(bytes, file.mime)
        await client.serialized(binding.chat, () =>
          client.call('sendChatAction', {
            chat_id: binding.chat,
            message_thread_id: binding.thread || undefined,
            action: 'upload_voice',
          }),
        )
        await sendCachedMedia(client, accountId, binding.chat, prepared.method, prepared, {
          message_thread_id: binding.thread || undefined,
          caption: native ? undefined : file.speakerName,
          duration: file.durationMs === undefined ? undefined : Math.ceil(file.durationMs / 1000),
        })
      }
    } catch {
      this.log(accountId, 'media.voice.failed')
    }
  }
  async deliver(
    binding: ChannelBindingDTO,
    message: MessageDTO,
    settings: ChannelSettings,
    client: ChannelClient,
    accountId: string,
    native = false,
  ) {
    // 与文字相同的可见性边界；私信、暗骰和盲骰禁止降级到群媒体。
    if (
      message.meta.hidden ||
      message.meta.channel === 'whisper' ||
      (message.meta.visibility && message.meta.visibility.level !== 'public')
    )
      return
    if (message.role !== 'assistant' && message.role !== 'system') return
    const key = `channels:media-delivery:${binding.id}:${message.id}`
    const saved = getSetting<Record<string, string>>(key) ?? {}
    const once = async (name: string, revision: string, fn: () => Promise<unknown>) => {
      if (saved[name] === revision) return
      try {
        await fn()
        saved[name] = revision
        setSetting(key, saved)
      } catch {
        this.log(accountId, `media.${name}.failed`)
      }
    }
    const thread = { message_thread_id: binding.thread || undefined }
    const photo = async (url: string, mode: 'send' | 'spoiler', caption?: string) => {
      const asset = await readMediaAsset(url)
      if (!asset) throw new Error('asset')
      return sendCachedMedia(client, accountId, binding.chat, 'sendPhoto', asset, {
        ...thread,
        has_spoiler: mode === 'spoiler',
        caption: caption?.slice(0, 1024),
      })
    }
    const pending = message.meta.imageGen && !['done', 'error'].includes(message.meta.imageGen.status)
    // 生图使用平台活动提示，避免新增和清理占位消息造成额外噪声。
    if (pending && settings.generatedImages !== 'off')
      await once('drawing', 'pending', () =>
        client.serialized(binding.chat, () =>
          client.call('sendChatAction', { chat_id: binding.chat, ...thread, action: 'upload_photo' }),
        ),
      )
    for (const image of message.meta.images ?? []) {
      const isCg = image.isCg || message.meta.cg?.some((cg) => cg.attachmentId === image.id)
      const mode = isCg ? settings.cg : settings.generatedImages
      if (mode !== 'off') await once(`image.${image.id}`, hash(image), () => photo(image.url, mode, image.caption))
    }
    const parsed = parseStageMessage(message.content, {
      knownNames: stageMembers(binding.chatId).map((member) => member.name),
      vars: {},
      inline: true,
      mvu: true,
    })
    const stage = message.meta.stage ?? parsed.stage
    if (settings.sprites !== 'off') {
      const ops = [...stage.ops]
      if (
        message.speakerId &&
        !ops.some(
          (op) =>
            (op.op === 'show' || op.op === 'expr') &&
            matchStageMember(binding.chatId, op.who)?.id === message.speakerId,
        )
      ) {
        const speaker = stageMembers(binding.chatId).find((member) => member.id === message.speakerId)
        if (speaker) ops.push({ op: 'show', who: speaker.name })
      }
      for (const op of ops) {
        if (op.op !== 'show' && op.op !== 'expr') continue
        const member = matchStageMember(binding.chatId, op.who)
        if (!member) continue
        const stateKey = `channels:sprite:${binding.id}:${member.id}`
        const previous = getSetting<{ expression: string; outfit: string }>(stateKey)
        const expression = op.expression ?? previous?.expression ?? 'neutral'
        const outfit = 'outfit' in op ? (op.outfit ?? previous?.outfit ?? '') : (previous?.outfit ?? '')
        const state = hash([expression, outfit])
        if (settings.sprites === 'changes' && previous && hash([previous.expression, previous.outfit]) === state)
          continue
        await once(`sprite.${member.id}.${state}`, hash([message.content, state]), async () => {
          const sprite = pickSprite(listSprites(member.id), {
            expression,
            outfit,
            fallback: 'neutral',
            random: false,
            seed: message.id,
          })
          if (!sprite) return
          const asset = await readMediaAsset(sprite.url)
          if (!asset) throw new Error('sprite')
          // PNG 文档保留透明通道；不经 Telegram 的照片重压缩。
          await sendCachedMedia(
            client,
            accountId,
            binding.chat,
            'sendDocument',
            {
              bytes: await sharp(asset.bytes).png().toBuffer(),
              mime: 'image/png',
              filename: `${member.id}.png`,
            },
            { ...thread, caption: `${member.name} · ${expression}` },
          )
          setSetting(stateKey, { expression, outfit })
        })
      }
    }
    if (settings.background) {
      for (const op of stage.ops) {
        if (op.op !== 'scene' || !op.bg) continue
        const background = backgroundsForChat(binding.chatId).find((bg) => bg.id === op.bg || bg.name === op.bg)
        if (background)
          await once('background', hash([message.content, background.id]), () =>
            photo(background.url, 'send', background.name),
          )
      }
    }
    const vars = { ...parsed.varsPatch, ...message.meta.varsPatch, ...message.meta.varsManual }
    if (settings.statusCard !== 'off' && vars && Object.keys(vars).length) {
      await once('status', hash(vars), async () => {
        const text = `<blockquote expandable>${escapeHtml(
          Object.entries(vars)
            .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
            .join('\n')
            .slice(0, 3500),
        )}</blockquote>`
        const stateKey = `channels:status:${binding.id}`
        const pinned = getSetting<number>(stateKey)
        await client.serialized(binding.chat, async () => {
          if (settings.statusCard === 'pinned' && pinned) {
            try {
              await client.call('editMessageText', {
                chat_id: binding.chat,
                message_id: pinned,
                text,
                parse_mode: 'HTML',
              })
              return
            } catch {
              this.log(accountId, 'media.status.edit.failed')
            }
          }
          const sent = await client.call<{ message_id: number }>('sendMessage', {
            chat_id: binding.chat,
            ...thread,
            text,
            parse_mode: 'HTML',
          })
          if (settings.statusCard === 'pinned') {
            try {
              await client.call('pinChatMessage', {
                chat_id: binding.chat,
                message_id: sent.message_id,
                disable_notification: true,
              })
              setSetting(stateKey, sent.message_id)
            } catch {
              this.log(accountId, 'media.status.pin.unavailable')
            }
          }
        })
      })
    }
    if (
      settings.voice === 'auto' &&
      message.role === 'assistant' &&
      message.status === 'done' &&
      message.content.trim()
    ) {
      const revision = hash([message.content, message.speakerId])
      await once('voice', revision, () => this.speak(binding, message, client, accountId, native))
    }
  }
}
