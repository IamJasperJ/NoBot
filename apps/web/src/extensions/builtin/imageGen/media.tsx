import type { MessageDTO } from '@nobot/shared'
import { ImagePromptDialog } from '../../../features/chat/ImagePromptDialog'
import { t } from '../../../i18n'
import type { ImageGenRuntime } from './runtime'
import { errorText } from './shared'

export function createMedia(runtime: ImageGenRuntime) {
  const { api, R, h, request, refresh } = runtime
  function Media({ chatId, message }: { chatId: string; message: MessageDTO }) {
    const pending = message.meta.imageGen?.status === 'pending'
    const [editing, setEditing] = R.useState(false)
    // 占位框的刷新由聊天页统一负责（有 pending 图片时每 2 秒刷新会话），这里不再单独轮询
    if (!message.meta.imageGen) return null
    const task = message.meta.imageGen
    // 改提示词重新生成：保留现有图片，用新提示词再生成一张追加在后面（和「生成备选图」一样）
    const regenerate = async (edited: { prompt: string; negative: string }) => {
      try {
        await request('retry', { messageId: message.id, append: true, ...edited })
        await refresh(chatId)
      } catch (error) {
        api.toast.error(errorText(error))
      }
    }
    const background = async () => {
      try {
        await request('to-background', {
          messageId: message.id,
          index: message.meta.imageIndex ?? (message.meta.images?.length ?? 1) - 1,
        })
        api.toast.info(t('已生成背景并设为聊天背景'))
        await refresh(chatId, true)
      } catch (error) {
        api.toast.error(errorText(error))
      }
    }
    const mediaButton =
      'inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-40 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
    const icon = (d: string) =>
      h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d }),
      )
    return h(
      R.Fragment,
      null,
      !!message.meta.images?.length &&
        (message.meta.imageIndex ?? message.meta.images.length - 1) < message.meta.images.length &&
        h(
          R.Fragment,
          null,
          h(
            'button',
            { type: 'button', className: mediaButton, disabled: pending, onClick: background },
            icon('M3 5h18v14H3zM3 15l5-5 4 4 3-3 6 6'),
            t('设为聊天背景'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: mediaButton,
              disabled: pending,
              title: t('修改这张图的提示词，再生成一张（现有图片保留，可以左右切换）'),
              onClick: () => setEditing(true),
            },
            icon('M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'),
            t('修改提示词'),
          ),
        ),
      editing &&
        h(ImagePromptDialog, {
          react: R,
          title: t('修改提示词，再生成一张'),
          review: {
            preview: { prompt: task.prompt ?? '', negative: task.negative ?? '' },
            resolve: (edited: { prompt: string; negative: string } | null) => {
              setEditing(false)
              if (edited) void regenerate(edited)
            },
          },
        }),
    )
  }
  return Media
}
