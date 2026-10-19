import { t } from '../../../i18n'
import type { ActivateFn, SlotProps } from '../../types'
import { AudioLibraryPage } from './LibraryPage'
import { useVnAudio } from './useVnAudio'
import { VolumeControl } from './VolumeControl'

export function VnAudioLayer(props: SlotProps['vn.layer']) {
  useVnAudio(props)
  return null
}

/**
 * 音频扩展的前端（后端见 apps/server/src/extensions/builtin/audio）：
 * - 扩展页里的「音频库」标签
 * - VN 里按舞台状态放 BGM、走到 sfx 拍放音效（不可见层）
 * - VN 工具栏的音量按钮
 */
const activate: ActivateFn = (api) => {
  api.registerPage({
    id: 'library',
    get label() {
      return t('音频库')
    },
    icon: '🎵',
    render: () => <AudioLibraryPage />,
  })
  api.registerSlot('vn.layer', { id: 'audio', render: (props) => <VnAudioLayer {...props} /> })
  api.registerSlot('vn.toolbar', { id: 'volume', render: () => <VolumeControl /> })
}
export default activate
