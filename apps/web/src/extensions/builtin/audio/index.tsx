import { parseStageMessage } from '@nobot/core/stage'
import { api as client } from '../../../api/client'
import { ttsApi } from '../../../api/tts'
import { t } from '../../../i18n'
import { useStreaming } from '../../../stores/streaming'
import { useVn } from '../../../stores/vn'
import { useVnVoiceStore } from '../../../stores/vnVoice'
import type { ActivateFn, SlotProps } from '../../types'
import { AutoReader } from './auto-read'
import { ChatBgmDialog, ChatBgmMenuEntry } from './ChatBgmUi'
import { ChatVoiceSection } from './ChatVoiceSection'
import { FishVoiceSearch } from './FishVoiceSearch'
import { AudioLibraryPage } from './LibraryPage'
import { TtsNowPlaying } from './TtsNowPlaying'
import { CharacterVoiceSection, ReadAloudAction, TtsCacheFooter, VoiceField, VoiceListField } from './TtsUi'
import { ttsPlayer } from './tts-player'
import { useChatAudio } from './useChatAudio'
import { getVisibleTtsChat, useStopTtsOnLeave } from './useStopTtsOnLeave'
import { useVnAudio } from './useVnAudio'
import { useVnVoice } from './useVnVoice'
import { VolumeControl } from './VolumeControl'

function ChatAudioLayer({ chatId }: SlotProps['chat.layer']) {
  useStopTtsOnLeave(chatId)
  useChatAudio(chatId)
  // BGM 选择框放在这一层：「+」菜单收起时会卸载里面的内容
  return (
    <>
      <ChatBgmDialog chatId={chatId} />
      <TtsNowPlaying chatId={chatId} />
    </>
  )
}

export function VnAudioLayer(props: SlotProps['vn.layer']) {
  useStopTtsOnLeave(props.chatId)
  useVnAudio(props)
  useVnVoice(props)
  return <TtsNowPlaying chatId={props.chatId} vn />
}

/**
 * 音频扩展的前端（后端见 apps/server/src/extensions/builtin/audio）：
 * - 扩展页里的「音频库」标签
 * - VN 里按舞台状态放 BGM、走到 sfx 拍放音效（不可见层）
 * - VN 工具栏的音量按钮
 * - 朗读（TTS）：设置里的声音字段和缓存管理、角色编辑器的「声音」分组、消息菜单的「朗读」、VN 逐句朗读
 */
const activate: ActivateFn = (api) => {
  let active = true
  const reader = new AutoReader()
  let pending = Promise.resolve()
  type View = NonNullable<ReturnType<typeof getVisibleTtsChat>>
  const streamMessages = new Map<string, Awaited<ReturnType<typeof client.getChatPage>>['messages'][number]>()
  const contexts = new WeakMap<
    View,
    Promise<{
      voice: Awaited<ReturnType<typeof ttsApi.chatVoice>>
      page: Awaited<ReturnType<typeof client.getChatPage>>
      presets: Awaited<ReturnType<typeof client.listPlayPresets>>
    }>
  >()
  const context = (view: View) => {
    let result = contexts.get(view)
    if (!result) {
      result = Promise.all([
        ttsApi.chatVoice(view.chatId),
        client.getChatPage(view.chatId),
        client.listPlayPresets(),
      ]).then(([voice, page, presets]) => ({ voice, page, presets }))
      contexts.set(view, result)
    }
    return result
  }
  const allowed = (view: View, data: Awaited<ReturnType<typeof context>>) => {
    const mode = useVn.getState().mode[view.chatId]
    const preset = data.presets.find((p) => p.id === data.page.playPresetId)
    return (
      active &&
      getVisibleTtsChat() === view &&
      data.voice.effective.enabled &&
      data.voice.effective.autoRead &&
      !(mode ? mode === 'vn' : preset?.data.basic.openInVn)
    )
  }
  const report = (error: unknown, view: View) => {
    if (!active || getVisibleTtsChat() !== view) return
    useVnVoiceStore.setState({
      lastVoiceError: { message: error instanceof Error ? error.message : t('语音播放失败'), at: Date.now() },
    })
  }
  const offStream = useStreaming.subscribe((state, previous) => {
    const view = getVisibleTtsChat()
    if (!view) return
    const ended = previous.chatId === view.chatId && previous.messageId && previous.messageId !== state.messageId
    const live = state.chatId === view.chatId && state.messageId ? { ...state } : null
    if (!ended && (!live || (state.text === previous.text && state.messageId === previous.messageId))) return
    // 在回调时保存快照；网络请求串行完成后仍按生成顺序提交，不丢失短回复。
    pending = pending
      .then(async () => {
        const data = await context(view)
        if (!allowed(view, data) || !data.voice.effective.streamRead) return
        if (ended) {
          const page = await client.getChatPage(view.chatId)
          if (!allowed(view, data)) return
          const message = page.messages.find((m) => m.id === previous.messageId)
          if (message && message.status !== 'streaming')
            reader.read(view.chatId, message, data.voice.members, false, true)
        }
        if (live?.messageId) {
          if (!streamMessages.has(live.messageId)) {
            const page = await client.getChatPage(view.chatId)
            for (const message of page.messages) streamMessages.set(message.id, message)
          }
          if (!allowed(view, data)) return
          const message = streamMessages.get(live.messageId)
          if (message) {
            const play = data.presets.find((preset) => preset.id === data.page.playPresetId)?.data
            // 开启舞台指令时按同一预设解析，避免完成后的旁白拆拍改变已入队分段的位置。
            const stage = play?.directives.enabled
              ? parseStageMessage(live.text, {
                  knownNames: [...data.voice.members, ...data.voice.npcs].map((actor) => actor.name),
                  narratorNames: [play.trpg.gmName],
                  vars: {},
                  inline: play.state.inline,
                  mvu: play.state.mvu,
                  narrationSplit: play.dialog.narrationSplit,
                }).stage
              : undefined
            reader.read(
              view.chatId,
              { ...message, content: live.text, meta: { ...message.meta, stage } },
              data.voice.members,
              true,
              true,
            )
          }
        }
      })
      .catch((error: unknown) => report(error, view))
  })
  const offStart = api.on('generation:start', ({ chatId }) => {
    const view = getVisibleTtsChat()
    if (view?.chatId === chatId) {
      contexts.delete(view)
      streamMessages.clear()
    }
  })
  const off = api.on('generation:complete', ({ chatId }) => {
    const view = getVisibleTtsChat()
    if (view?.chatId !== chatId) return
    pending = pending
      .then(async () => {
        // 完成时重新读取设置与消息，群聊的一次 complete 要收齐最后一条用户消息后的全部回复。
        const effective = await ttsApi.chatVoice(chatId)
        if (!effective.effective.enabled || !effective.effective.autoRead) return
        const page = await client.getChatPage(chatId)
        const presets = await client.listPlayPresets()
        const data = { voice: effective, page, presets }
        if (!allowed(view, data)) return
        const start = page.messages.findLastIndex((m) => m.role === 'user') + 1
        for (const message of page.messages.slice(start)) {
          if (message.role === 'assistant' && message.status !== 'streaming')
            reader.read(chatId, message, effective.members, false, effective.effective.streamRead)
        }
      })
      .catch((error: unknown) => report(error, view))
  })
  api.registerPage({
    id: 'library',
    get label() {
      return t('音频库')
    },
    icon: '🎵',
    render: () => <AudioLibraryPage />,
  })
  api.registerSlot('chat.layer', { id: 'audio', render: (props) => <ChatAudioLayer {...props} /> })
  api.registerSlot('chat.settings.sections', {
    id: 'voice',
    get title() {
      return t('声音')
    },
    order: 60,
    defaultOpen: false,
    render: ({ chatId }) => <ChatVoiceSection key={chatId} chatId={chatId} />,
  })
  api.registerSlot('chat.composer.menu', {
    id: 'bgm',
    render: ({ chatId, close }) => <ChatBgmMenuEntry chatId={chatId} close={close} />,
  })
  api.registerSlot('vn.layer', { id: 'audio', render: (props) => <VnAudioLayer {...props} /> })
  api.registerSlot('vn.toolbar', { id: 'volume', render: () => <VolumeControl /> })
  api.registerSlot('extensions.settings.field', { id: 'narratorVoice', render: (props) => <VoiceField {...props} /> })
  api.registerSlot('extensions.settings.field', { id: 'userVoice', render: (props) => <VoiceField {...props} /> })
  api.registerSlot('extensions.settings.field', { id: 'npcVoices', render: (props) => <VoiceListField {...props} /> })
  api.registerSlot('extensions.settings.field', {
    id: 'fishVoiceSearch',
    render: (props) => <FishVoiceSearch {...props} />,
  })
  api.registerSlot('extensions.settings.footer', { id: 'tts-cache', render: () => <TtsCacheFooter /> })
  api.registerSlot('character.editor.sections', {
    id: 'voice',
    get title() {
      return t('声音')
    },
    render: (props) => <CharacterVoiceSection key={props.character.id} {...props} />,
  })
  api.registerSlot('chat.message.actions', {
    id: 'read-aloud',
    render: ({ message }) => <ReadAloudAction message={message} />,
  })
  return () => {
    active = false
    off()
    offStart()
    offStream()
    ttsPlayer.stop()
  }
}
export default activate
