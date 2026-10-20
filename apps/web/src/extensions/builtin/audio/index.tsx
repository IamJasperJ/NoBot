import { api as client } from '../../../api/client'
import { t } from '../../../i18n'
import { useVn } from '../../../stores/vn'
import type { ActivateFn, SlotProps } from '../../types'
import { ChatBgmDialog, ChatBgmMenuEntry } from './ChatBgmUi'
import { AudioLibraryPage } from './LibraryPage'
import { CharacterVoiceSection, ReadAloudAction, TtsCacheFooter, VoiceField, VoiceListField } from './TtsUi'
import { ttsPlayer } from './tts-player'
import { useChatAudio } from './useChatAudio'
import { useVnAudio } from './useVnAudio'
import { useVnVoice } from './useVnVoice'
import { VolumeControl } from './VolumeControl'

function ChatAudioLayer({ chatId }: SlotProps['chat.layer']) {
  useChatAudio(chatId)
  // BGM 选择框放在这一层：「+」菜单收起时会卸载里面的内容
  return <ChatBgmDialog chatId={chatId} />
}

export function VnAudioLayer(props: SlotProps['vn.layer']) {
  useVnAudio(props)
  useVnVoice(props)
  return null
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
    const current = ++requestId
    void (async () => {
      const extension = (await client.listExtensions()).find((e) => e.id === 'audio')
      if (!extension?.enabled || !extension.settings.ttsEnabled || !extension.settings.autoRead) return
      const page = await client.getChatPage(chatId)
      const presets = await client.listPlayPresets()
      const preset = presets.find((p) => p.id === page.playPresetId)
      const mode = useVn.getState().mode[chatId]
      if (!active || current !== requestId || (mode ? mode === 'vn' : preset?.data.basic.openInVn)) return
      const message = page.messages.filter((m) => m.role === 'assistant').at(-1)
      if (message) await ttsPlayer.speakMessage(message.id)
    })().catch(() => console.warn('TTS playback failed'))
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
  api.registerSlot('chat.composer.menu', {
    id: 'bgm',
    render: ({ chatId, close }) => <ChatBgmMenuEntry chatId={chatId} close={close} />,
  })
  api.registerSlot('vn.layer', { id: 'audio', render: (props) => <VnAudioLayer {...props} /> })
  api.registerSlot('vn.toolbar', { id: 'volume', render: () => <VolumeControl /> })
  api.registerSlot('extensions.settings.field', { id: 'narratorVoice', render: (props) => <VoiceField {...props} /> })
  api.registerSlot('extensions.settings.field', { id: 'userVoice', render: (props) => <VoiceField {...props} /> })
  api.registerSlot('extensions.settings.field', { id: 'npcVoices', render: (props) => <VoiceListField {...props} /> })
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
