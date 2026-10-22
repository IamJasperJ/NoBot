import { t } from '../../../i18n'
import type { ClientExtensionAPI } from '../../types'
import { createCharacterSection } from './character'
import { createComposer } from './composer'
import { createGallery } from './gallery'
import { MattingModelField } from './matting'
import { createMedia } from './media'
import { createRuntime } from './runtime'
import { StyleField, WorkflowField } from './settings'
import { createImageSettingsFooter } from './settings-footer'
import { buttonClass, errorText } from './shared'

export { imageModes, subscribeChatCache } from './shared'

export default function activate(api: ClientExtensionAPI) {
  const runtime = createRuntime(api)
  const { h, request, refresh, reviews, generate } = runtime
  const Composer = createComposer(runtime)
  const Media = createMedia(runtime)
  const CharacterSection = createCharacterSection(runtime)
  const Gallery = createGallery(runtime)
  const ImageSettingsFooter = createImageSettingsFooter(runtime)
  api.registerPage({
    id: 'gallery',
    get label() {
      return t('图库')
    },
    icon: '🖼',
    render: () => h(Gallery),
  })
  api.registerSlot('character.editor.sections', {
    id: 'image-prompts',
    get title() {
      return t('图片生成')
    },
    render: (props) => h(CharacterSection, { ...props, key: props.character.id }),
  })
  // 自动背景在文本流结束后继续生成，完成后刷新与手动背景相同的缓存。
  const backgroundPolls = new Set<ReturnType<typeof setTimeout>>()
  let disposed = false
  const unsubscribeBackground = api.on('generation:complete', ({ chatId }) => {
    const poll = async () => {
      try {
        const response = await api.fetchServer(`/background-status?chatId=${encodeURIComponent(chatId)}`)
        if (!response.ok || disposed) return
        const status = (await response.json()) as { running: boolean }
        if (status.running) {
          const timer = setTimeout(() => {
            backgroundPolls.delete(timer)
            void poll()
          }, 2000)
          backgroundPolls.add(timer)
        } else {
          await refresh(chatId, true)
        }
      } catch {
        // 网络错误时由下次打开会话恢复，不打断聊天。
      }
    }
    void poll()
  })
  const unsubscribe = api.on('image:swipe-next', (event) => {
    if (event.message.meta.imageGen?.status === 'pending') return
    void request('retry', { messageId: event.message.id, append: true })
      .then(() => refresh(event.chatId))
      .catch((error) => api.toast.error(errorText(error)))
  })
  api.registerSlot('chat.composer.buttons', { id: 'generate', render: (props) => h(Composer, props) })
  api.registerSlot('chat.message.actions', {
    id: 'generate-message',
    render: ({ chatId, message }) =>
      h(
        'button',
        {
          type: 'button',
          className: buttonClass,
          onClick: () => generate(chatId, 'message', { messageId: message.id }),
        },
        t('为这条消息生成图片'),
      ),
  })
  api.registerSlot('chat.message.media', { id: 'media', render: (props) => h(Media, props) })
  api.registerSlot('extensions.settings.footer', {
    id: 'settings',
    render: (props) => h(ImageSettingsFooter, props),
  })
  // 设置表单里的自定义控件：工作流管理、风格管理
  api.registerSlot('extensions.settings.field', {
    id: 'comfyWorkflowName',
    render: (props) => h(WorkflowField, props),
  })
  api.registerSlot('extensions.settings.field', {
    id: 'activeStyle',
    render: (props) => h(StyleField, props),
  })
  api.registerSlot('extensions.settings.field', {
    id: 'mattingModel',
    render: (props) => h(MattingModelField, props),
  })
  return () => {
    disposed = true
    unsubscribeBackground()
    for (const timer of backgroundPolls) clearTimeout(timer)
    backgroundPolls.clear()
    unsubscribe()
    for (const review of reviews.values()) review.resolve(null)
    reviews.clear()
  }
}
