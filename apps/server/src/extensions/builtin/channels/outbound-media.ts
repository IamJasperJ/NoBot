import { createHash } from 'node:crypto'
import { parseStageMessage, pickSprite } from '@nobot/core/stage'
import type { ChannelBindingDTO, MessageDTO } from '@nobot/shared'
import sharp from 'sharp'
import { getSetting, setSetting } from '../../../db/client'
import { t } from '../../../i18n'
import { backgroundsForChat } from '../../../services/backgrounds/backgrounds'
import { matchStageMember, stageMembers } from '../../../services/generation/stage'
import { listSprites } from '../../../services/sprites/sprites'
import type { ExtensionHost } from '../../types'
import { OneBotClient } from './adapters/onebot11/client'
import { prepareAudio, readMediaAsset, sendCachedMedia } from './adapters/telegram/media'
import { escapeHtml } from './adapters/telegram/render'
import type { ChannelClient } from './adapters/types'
import { omitSpeakerPrefix } from './speaker-prefix'
import { accountRow, listBindings } from './store'
import { isImageMessage, visibleContent, visibleText } from './visible-text'
import type { VoiceDeliverySettings } from './voice-decision'
import { channelSpeechPlan } from './voice-text'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class OutboundMedia {
  private drawing = new Map<
    string,
    { timer: ReturnType<typeof setInterval>; placeholder?: number; started: number; busy: boolean }
  >()
  dispose() {
    for (const state of this.drawing.values()) clearInterval(state.timer)
    this.drawing.clear()
  }

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
    settings?: VoiceDeliverySettings,
  ) {
    if (isImageMessage(message)) return
    let recording: ReturnType<typeof setInterval> | undefined
    try {
      await client.serialized(binding.chat, () =>
        client.call('sendChatAction', {
          chat_id: binding.chat,
          message_thread_id: binding.thread || undefined,
          action: 'record_voice',
        }),
      )
      if (!(client instanceof OneBotClient)) {
        recording = setInterval(() => {
          void client
            .call('sendChatAction', {
              chat_id: binding.chat,
              message_thread_id: binding.thread || undefined,
              action: 'record_voice',
            })
            .catch(() => {})
        }, 4000)
      }
      const signal = AbortSignal.timeout(60000)
      const plan =
        settings && (settings.voice === 'only' || settings.voiceDecisionSpeaker)
          ? channelSpeechPlan(message, stageMembers(binding.chatId), settings)
          : undefined
      type File = Extract<Awaited<ReturnType<ExtensionHost['synthesizeSpeech']>>, { kind: 'audio' }>['files'][number]
      const outputs: File[] = []
      const selectedSegments = plan?.segments.filter(
        (segment) =>
          !settings?.voiceDecisionSpeaker ||
          segment.speaker.kind === 'narrator' ||
          (segment.speaker.kind === 'character' && segment.speaker.characterId === settings.voiceDecisionSpeaker),
      )
      const tasks = selectedSegments?.map((segment) => ({ segment })) ?? [{ segment: undefined }]
      // 合成全部成功后才上传，避免中途失败时遗漏后半句。
      for (const { segment } of tasks) {
        const task = this.host.synthesizeSpeech(binding.chatId, message.id, {
          signal,
          ...(segment ? { segments: [segment] } : {}),
        })
        const result = await new Promise<Awaited<typeof task>>((resolve, reject) => {
          const abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          void task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
          // 合成开始时已经超时也要接住底层 Promise，避免产生未处理的拒绝。
          if (signal.aborted) abort()
        })
        if (result.kind !== 'audio') {
          this.log(accountId, `media.voice.${result.reason}`)
          return t('语音合成尚未配置，请检查语音设置')
        }
        outputs.push(...result.files)
      }
      for (const file of outputs) {
        signal.throwIfAborted()
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
          caption:
            (native && (!file.speakerId || file.speakerId === message.speakerId)) ||
            omitSpeakerPrefix(
              binding,
              { ...message, speakerId: file.speakerId ?? message.speakerId },
              accountId,
              accountRow(accountId).config,
            ) ||
            settings?.personaPrefix === false
              ? undefined
              : file.speakerName,
          duration: file.durationMs === undefined ? undefined : Math.ceil(file.durationMs / 1000),
        })
      }
    } catch {
      this.log(accountId, 'media.voice.failed')
      return t('语音发送失败，请稍后重试')
    } finally {
      clearInterval(recording)
    }
  }
  /** 成功才替换正文；失败信息只写日志，正文走原有投递路径。 */
  async onlyText(
    binding: ChannelBindingDTO,
    message: MessageDTO,
    settings: VoiceDeliverySettings,
    client: ChannelClient,
    accountId: string,
    native = false,
  ) {
    if (
      settings.voice !== 'only' ||
      message.role !== 'assistant' ||
      message.status !== 'done' ||
      isImageMessage(message)
    )
      return undefined
    if (settings.voiceLongText === 'text' && Array.from(visibleText(message)).length > settings.voiceMaxChars)
      return undefined
    const error = await this.speak(binding, message, client, accountId, native, settings)
    if (error) return undefined
    return channelSpeechPlan(message, stageMembers(binding.chatId), settings).narration
  }
  async deliver(
    binding: ChannelBindingDTO,
    message: MessageDTO,
    settings: VoiceDeliverySettings,
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
    if (!['assistant', 'system', 'tool'].includes(message.role)) return
    const explicit = message.meta.clientMessageId === 'imagine'
    const drawingKey = `${binding.id}:${binding.chat}:${message.id}`
    if (message.meta.imageGen) {
      const pending = !['done', 'error'].includes(message.meta.imageGen.status)
      if (
        pending &&
        (explicit || settings.generatedImages !== 'off') &&
        !(client instanceof OneBotClient) &&
        !this.drawing.has(drawingKey)
      ) {
        const tick = async () => {
          const state = this.drawing.get(drawingKey)
          if (!state || state.busy) return
          const current = listBindings(binding.accountId).find((item) => item.id === binding.id)
          if (current?.state !== 'active' || current.chatId !== message.chatId || Date.now() - state.started > 600000) {
            clearInterval(state.timer)
            this.drawing.delete(drawingKey)
            if (state.placeholder)
              await client
                .call('deleteMessage', { chat_id: binding.chat, message_id: state.placeholder })
                .catch(() => {})
            return
          }
          state.busy = true
          try {
            await client.call('sendChatAction', {
              chat_id: binding.chat,
              message_thread_id: binding.thread || undefined,
              action: 'upload_photo',
            })
            if (explicit && Date.now() - state.started >= 3000 && !state.placeholder) {
              const sent = await client.call<{ message_id: number }>('sendMessage', {
                chat_id: binding.chat,
                message_thread_id: binding.thread || undefined,
                text: t('🎨 正在画…'),
              })
              state.placeholder = sent.message_id
              // 完成事件可能先于 sendMessage 的响应到达，迟到占位同样要清理。
              if (!this.drawing.has(drawingKey))
                await client.call('deleteMessage', { chat_id: binding.chat, message_id: sent.message_id })
            }
          } catch {
            this.log(accountId, 'media.drawing.failed')
          } finally {
            state.busy = false
          }
        }
        this.drawing.set(drawingKey, { timer: setInterval(() => void tick(), 3000), started: Date.now(), busy: false })
        await tick()
      }
      if (!pending || (!explicit && settings.generatedImages === 'off')) {
        const state = this.drawing.get(drawingKey)
        this.drawing.delete(drawingKey)
        if (state) {
          clearInterval(state.timer)
          if (state.placeholder)
            await client.call('deleteMessage', { chat_id: binding.chat, message_id: state.placeholder }).catch(() => {})
        }
      }
    }
    const key = `channels:media-delivery:${binding.id}:${binding.chat}:${message.id}`
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
    if ((explicit || settings.generatedImages !== 'off') && message.meta.imageGen?.status === 'error')
      await once('error', 'error', () =>
        client.call('sendMessage', {
          chat_id: binding.chat,
          ...thread,
          text: t('图片生成失败，请检查生图设置后重试'),
        }),
      )
    const images = (message.role === 'tool' && !message.meta.imageGen ? [] : (message.meta.images ?? [])).filter(
      (image) => {
        const cg = image.isCg || message.meta.cg?.some((item) => item.attachmentId === image.id)
        return cg ? settings.cg !== 'off' : explicit || settings.generatedImages !== 'off'
      },
    )
    // 相册逐批发送，Telegram 每组最多十张；重放元数据更新不应重复发图。
    for (let start = 0; start < images.length; start += 10) {
      const batch = images.slice(start, start + 10)
      await once(`images.${start}`, hash(batch), async () => {
        const media = await Promise.all(
          batch.map(async (image) => {
            const asset = await readMediaAsset(image.url)
            if (!asset) throw new Error('asset')
            const cg = image.isCg || message.meta.cg?.some((item) => item.attachmentId === image.id)
            return { asset, spoiler: (cg ? settings.cg : settings.generatedImages) === 'spoiler' }
          }),
        )
        if (client instanceof OneBotClient) {
          await client.send(
            binding.chat.replace(/^-/, ''),
            media.map(({ asset, spoiler }) => ({
              type: 'image',
              data: {
                file: `base64://${Buffer.from(asset.bytes).toString('base64')}`,
                ...(spoiler ? { type: 'flash' } : {}),
              },
            })),
            binding.scope,
          )
        } else if (media.length === 1) {
          await sendCachedMedia(client, accountId, binding.chat, 'sendPhoto', media[0]!.asset, {
            ...thread,
            has_spoiler: media[0]!.spoiler,
          })
        } else {
          const form = new FormData()
          form.set('chat_id', binding.chat)
          if (binding.thread) form.set('message_thread_id', binding.thread)
          form.set(
            'media',
            JSON.stringify(
              media.map(({ asset, spoiler }, index) => {
                form.set(`photo${index}`, new Blob([asset.bytes], { type: asset.mime }), asset.filename)
                return { type: 'photo', media: `attach://photo${index}`, has_spoiler: spoiler }
              }),
            ),
          )
          await client.serialized(binding.chat, () => client.call('sendMediaGroup', form))
        }
      })
    }
    if (isImageMessage(message) && !visibleText(message)) return
    const parsed = parseStageMessage(visibleContent(message), {
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
      visibleText(message) &&
      !isImageMessage(message)
    ) {
      const revision = hash([message.content, message.speakerId])
      await once('voice', revision, () => this.speak(binding, message, client, accountId, native, settings))
    }
  }
}
