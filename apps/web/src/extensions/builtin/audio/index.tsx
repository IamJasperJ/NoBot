import { api as client } from '../../../api/client'
import { ttsApi } from '../../../api/tts'
import { t } from '../../../i18n'
import { useVn } from '../../../stores/vn'
import { useVnVoiceStore } from '../../../stores/vnVoice'
import type { ActivateFn, SlotProps } from '../../types'
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
  let requestId = 0
  const off = api.on('generation:complete', ({ chatId }) => {
    const view = getVisibleTtsChat()
    if (view?.chatId !== chatId) return
    const current = ++requestId
    void (async () => {
      const { effective } = await ttsApi.chatVoice(chatId)
      if (!effective.enabled || !effective.autoRead) return
      const page = await client.getChatPage(chatId)
      const presets = await client.listPlayPresets()
      const preset = presets.find((p) => p.id === page.playPresetId)
      const mode = useVn.getState().mode[chatId]
      if (
        !active ||
        current !== requestId ||
        getVisibleTtsChat() !== view ||
        (mode ? mode === 'vn' : preset?.data.basic.openInVn)
      )
        return
      const message = page.messages.filter((m) => m.role === 'assistant').at(-1)
      if (message) await ttsPlayer.speakMessage(message.id, chatId)
    })().catch((error: unknown) => {
      if (!active || current !== requestId || getVisibleTtsChat() !== view) return
      useVnVoiceStore.setState({
        lastVoiceError: { message: error instanceof Error ? error.message : t('语音播放失败'), at: Date.now() },
      })
    })
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
    ttsPlayer.stop()
  }
}
export default activate
