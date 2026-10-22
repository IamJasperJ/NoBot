import type { ChatPage } from '@nobot/shared'
import { ImagePromptDialog } from '../../../features/chat/ImagePromptDialog'
import { t } from '../../../i18n'
import type { ImageGenRuntime } from './runtime'
import { buttonClass, imageModes, subscribeChatCache } from './shared'

export function createComposer(runtime: ImageGenRuntime) {
  const { api, R, h, reviews, active, listeners, generate } = runtime
  function Composer({ chatId }: { chatId: string }) {
    const [open, setOpen] = R.useState(false)
    const [free, setFree] = R.useState(false)
    const [input, setInput] = R.useState('')
    const [negative, setNegative] = R.useState('')
    const review = R.useSyncExternalStore(
      (notify) => {
        listeners.add(notify)
        return () => {
          listeners.delete(notify)
        }
      },
      () => [...reviews.values()].find((item) => item.chatId === chatId),
      () => [...reviews.values()].find((item) => item.chatId === chatId),
    )
    const root = R.useRef<HTMLDivElement>(null)
    const cache = R.useSyncExternalStore(
      (notify) => subscribeChatCache(api.queryClient, chatId, notify),
      () => api.queryClient.getQueryData<{ pages: ChatPage[] }>(['chat', chatId]),
      () => api.queryClient.getQueryData<{ pages: ChatPage[] }>(['chat', chatId]),
    )
    const requests = R.useSyncExternalStore(
      (notify) => {
        listeners.add(notify)
        return () => {
          listeners.delete(notify)
        }
      },
      () => active.get(chatId) ?? 0,
      () => active.get(chatId) ?? 0,
    )
    const pending = new Set(
      cache?.pages.flatMap((page) =>
        page.messages.filter((m) => m.meta.imageGen?.status === 'pending').map((m) => m.id),
      ),
    ).size
    const count = requests + pending
    const members = cache?.pages[0]?.group?.members ?? []
    R.useEffect(() => {
      if (!open && !free) return
      const outside = (event: PointerEvent) => {
        if (event.target instanceof Node && !root.current?.contains(event.target)) {
          setOpen(false)
          setFree(false)
        }
      }
      const onEscape = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          setOpen(false)
          setFree(false)
        }
      }
      document.addEventListener('pointerdown', outside)
      document.addEventListener('keydown', onEscape)
      return () => {
        document.removeEventListener('pointerdown', outside)
        document.removeEventListener('keydown', onEscape)
      }
    }, [open, free])
    function submit() {
      if (!input.trim()) return
      setFree(false)
      void generate(chatId, 'free', { input, negative })
    }
    const menuClass =
      'absolute bottom-10 left-0 z-20 max-h-[70vh] w-52 overflow-y-auto rounded-lg border border-zinc-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-800 dark:bg-zinc-900'
    const itemClass = 'block w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800'
    return h(
      'div',
      { ref: root, className: 'relative shrink-0' },
      review && h(ImagePromptDialog, { key: review.preview.snapshotId, review, react: R }),
      h(
        'button',
        {
          type: 'button',
          title: t('生成图片'),
          'aria-label': t('生成图片'),
          'aria-expanded': open,
          className:
            'relative inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800',
          onClick: () => {
            setOpen(!open)
            setFree(false)
          },
        },
        h(
          'svg',
          {
            width: 20,
            height: 20,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            'aria-hidden': true,
          },
          h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }),
          h('circle', { cx: 8, cy: 8, r: 1.5 }),
          h('path', { d: 'M3 17l5-5 4 4 4-6 5 7' }),
        ),
        count > 0 &&
          h(
            'span',
            {
              className:
                'absolute -top-1 -right-1 flex min-w-4 h-4 items-center justify-center rounded-full bg-violet-600 px-1 text-[10px] text-white',
              'aria-label': t('进行中的图片任务：{count}', { count }),
            },
            count,
          ),
      ),
      open &&
        h(
          'div',
          { className: menuClass },
          h('div', { className: 'px-3 py-1 text-xs text-zinc-500' }, t('生成图片')),
          ...imageModes()
            .filter(([key]) => key !== 'message')
            .flatMap(([key, name]) => {
              if ((key === 'character' || key === 'face') && members.length)
                return members.map((member) =>
                  h(
                    'button',
                    {
                      type: 'button',
                      key: `${key}:${member.characterId}`,
                      className: itemClass,
                      onClick: () => {
                        setOpen(false)
                        void generate(chatId, key, { characterId: member.characterId })
                      },
                    },
                    key === 'face'
                      ? t('画 {name}（脸部特写）', { name: member.name })
                      : t('画 {name}（全身）', { name: member.name }),
                  ),
                )
              return [
                h(
                  'button',
                  {
                    type: 'button',
                    key,
                    className: itemClass,
                    onClick: () => {
                      setOpen(false)
                      if (key === 'free') setFree(true)
                      else void generate(chatId, key)
                    },
                  },
                  name,
                ),
              ]
            }),
        ),
      free &&
        h(
          'div',
          { className: `${menuClass} flex flex-col gap-2 p-2`, role: 'dialog', 'aria-label': t('自由描述') },
          h('input', {
            autoFocus: true,
            className: 'rounded border border-zinc-500/30 bg-transparent px-2 py-1 text-sm',
            placeholder: t('以 ! 开头则直接作为提示词'),
            value: input,
            onChange: (event: { target: { value: string } }) => setInput(event.target.value),
            onKeyDown: (event: { key: string; nativeEvent: { isComposing: boolean }; preventDefault: () => void }) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submit()
              }
            },
          }),
          h('textarea', {
            'aria-label': t('本次负面提示词'),
            placeholder: t('负面提示词（可选）'),
            value: negative,
            onChange: (event: { target: { value: string } }) => setNegative(event.target.value),
            className: 'rounded border bg-transparent p-2',
          }),
          h('span', { className: 'text-xs text-zinc-500' }, t('以 ! 开头则直接作为提示词')),
          h('button', { type: 'button', className: buttonClass, disabled: !input.trim(), onClick: submit }, t('生成')),
        ),
    )
  }
  return Composer
}
