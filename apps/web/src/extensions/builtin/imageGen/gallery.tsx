import type { CharacterSummary } from '@nobot/shared'
import { createPortal } from 'react-dom'
import { t } from '../../../i18n'
import type { ImageGenRuntime } from './runtime'
import { buttonClass, errorText, type GalleryImage } from './shared'

export function createGallery(runtime: ImageGenRuntime) {
  const { api, R, h, request, refresh } = runtime
  function Gallery() {
    const [characters, setCharacters] = R.useState<CharacterSummary[]>([])
    const [characterId, setCharacterId] = R.useState('')
    const [images, setImages] = R.useState<GalleryImage[]>([])
    const [offset, setOffset] = R.useState(0)
    const [total, setTotal] = R.useState(0)
    const [selected, setSelected] = R.useState<GalleryImage>()
    const [error, setError] = R.useState('')
    R.useEffect(() => {
      let stale = false
      void (async () => {
        const list = await api.api.listCharacters()
        const current = api.getChatId()
        const chat = current ? await api.api.getChatPage(current) : undefined
        if (!stale) {
          setCharacters(list)
          setCharacterId(chat?.chat.characterId ?? chat?.group?.members[0]?.characterId ?? list[0]?.id ?? '')
        }
      })().catch((error) => {
        if (!stale) setError(errorText(error))
      })
      return () => {
        stale = true
      }
    }, [])
    R.useEffect(() => {
      if (!characterId) return
      let stale = false
      void request(`gallery?characterId=${encodeURIComponent(characterId)}&limit=40&offset=${offset}`)
        .then((data) => {
          if (!stale) {
            setImages(data.images ?? [])
            setTotal(data.total ?? 0)
            setError('')
          }
        })
        .catch((error) => {
          if (!stale) setError(errorText(error))
        })
      return () => {
        stale = true
      }
    }, [characterId, offset])
    async function background(item: GalleryImage) {
      try {
        const current = api.getChatId()
        if (!current) throw new Error(t('请先打开要设置背景的会话'))
        await request('gallery-background', { chatId: current, messageId: item.messageId, imageId: item.image.id })
        await refresh(current, true)
        api.toast.info(t('已设为当前聊天背景'))
      } catch (error) {
        api.toast.error(errorText(error))
      }
    }
    return h(
      'div',
      { className: 'space-y-4 p-4' },
      h('h2', { className: 'text-lg font-semibold' }, t('图库')),
      h(
        'select',
        {
          'aria-label': t('图库角色'),
          value: characterId,
          className: 'rounded border bg-transparent p-2',
          onChange: (event: { target: { value: string } }) => {
            setCharacterId(event.target.value)
            setOffset(0)
            setSelected(undefined)
          },
        },
        ...characters.map((character) => h('option', { key: character.id, value: character.id }, character.name)),
      ),
      error && h('p', { role: 'alert', className: 'text-red-500' }, error),
      h(
        'div',
        { className: 'grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4' },
        ...images.map((item) =>
          h(
            'button',
            {
              key: `${item.messageId}:${item.image.id}`,
              type: 'button',
              onClick: () => setSelected(item),
              className: 'overflow-hidden rounded-lg border',
            },
            h('img', { src: item.image.url, alt: item.prompt, loading: 'lazy', className: 'h-40 w-full object-cover' }),
          ),
        ),
      ),
      h(
        'div',
        { className: 'flex gap-3' },
        h(
          'button',
          {
            type: 'button',
            disabled: offset === 0,
            className: buttonClass,
            onClick: () => setOffset(Math.max(0, offset - 40)),
          },
          t('上一页'),
        ),
        h('span', null, t('共 {total} 张', { total })),
        h(
          'button',
          {
            type: 'button',
            disabled: offset + 40 >= total,
            className: buttonClass,
            onClick: () => setOffset(offset + 40),
          },
          t('下一页'),
        ),
      ),
      selected &&
        // 渲染到 body：覆盖层有毛玻璃（backdrop-filter）时，里面的 fixed 元素会被限制在覆盖层范围内
        createPortal(
          h(
            'div',
            {
              role: 'dialog',
              'aria-label': t('图片详情'),
              className: 'fixed inset-0 z-50 overflow-auto bg-black/80 p-6 text-white',
            },
            h('button', { type: 'button', className: buttonClass, onClick: () => setSelected(undefined) }, t('关闭')),
            h('img', { src: selected.image.url, alt: selected.prompt, className: 'mx-auto max-h-[70vh] max-w-full' }),
            h('p', { className: 'my-4 break-words' }, selected.prompt),
            h(
              'a',
              { href: selected.image.url, download: `${selected.image.id}.webp`, className: buttonClass },
              t('下载'),
            ),
            h(
              'button',
              { type: 'button', className: buttonClass, onClick: () => background(selected) },
              t('设为聊天背景'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: buttonClass,
                onClick: () => {
                  void api.openChat(selected.chatId).catch((error) => api.toast.error(errorText(error)))
                },
              },
              t('跳到消息所在会话'),
            ),
          ),
          document.body,
        ),
    )
  }
  return Gallery
}
