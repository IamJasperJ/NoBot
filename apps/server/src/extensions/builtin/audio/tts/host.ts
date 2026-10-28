import { basename, join } from 'node:path'
import { paths } from '../../../../env'
import { HttpError } from '../../../../errors'
import { t } from '../../../../i18n'
import { loadMessage } from '../../../../services/chats'
import { currentUser } from '../../../../user-context'
import type { ExtensionHost, ExtensionStorage, SpeechResult } from '../../../types'
import { effectiveSettings } from './chat-voice'
import { applyDirection, directMessage } from './director'
import { ttsEngines } from './engines'
import { messageSegments, resolveVoice, speakerDeliveryStyle, synthesizeVoice } from './service'
import { audioSettings } from './settings'

export interface AudioContext {
  settings: Record<string, unknown>
  storage: ExtensionStorage
}
export async function synthesizeSpeech(
  host: ExtensionHost,
  ctx: AudioContext,
  chatId: string,
  messageId: string,
  opts?: { signal?: AbortSignal; segments?: import('@nobot/core/stage').TtsSegment[] },
): Promise<SpeechResult> {
  if (loadMessage(messageId).chatId !== chatId) throw new HttpError(400, 'BAD_REQUEST', t('消息不在这个会话里'))
  const settings = effectiveSettings(chatId, audioSettings.parse(ctx.settings), ctx.storage)
  if (!settings.ttsEnabled) return { kind: 'unavailable', reason: 'tts-disabled' }
  const context = { ...ctx, host, userKey: currentUser().handle }
  let segments = opts?.segments ?? messageSegments(messageId).segments
  if (opts?.segments) settings.readNarration = true
  if (settings.deliveryDirector && settings.deliveryMode !== 'off') {
    const directions = await directMessage(context, messageId, chatId, segments)
    segments = segments.map((segment, i) => applyDirection(segment, directions[i]))
  }
  const files: Extract<SpeechResult, { kind: 'audio' }>['files'] = []
  for (const segment of segments) {
    opts?.signal?.throwIfAborted()
    const voice = await resolveVoice(chatId, segment.speaker, settings, context)
    if ('kind' in voice || voice.engine === 'browser' || !ttsEngines[voice.engine].configured(settings)) {
      if (opts?.segments) return { kind: 'unavailable', reason: 'no-voice' }
      continue
    }
    const result = await synthesizeVoice(
      voice,
      segment.text,
      settings,
      segment.expression,
      segment.delivery,
      segment.cues,
      speakerDeliveryStyle(segment.speaker, chatId),
      segment.director,
    )
    if (result.kind !== 'audio') {
      if (opts?.segments) return { kind: 'unavailable', reason: 'no-voice' }
      continue
    }
    const name = basename(result.url)
    files.push({
      path: join(paths.ttsCache, name),
      mime: name.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg',
      text: segment.text,
      speakerId: segment.speaker.kind === 'character' ? segment.speaker.characterId : undefined,
      speakerName:
        segment.speaker.kind === 'npc'
          ? segment.speaker.name
          : segment.speaker.kind === 'character'
            ? host.getCharacter(segment.speaker.characterId).name
            : undefined,
    })
  }
  return files.length ? { kind: 'audio', files } : { kind: 'unavailable', reason: 'no-voice' }
}
