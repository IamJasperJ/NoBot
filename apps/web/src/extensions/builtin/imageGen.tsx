import type { AttachmentDTO, CharacterDTO, CharacterSummary, ChatPage, MessageDTO } from '@nobot/shared'
import { createPortal } from 'react-dom'
import { ImagePromptDialog } from '../../features/chat/ImagePromptDialog'
import { t } from '../../i18n'
import type { ClientExtensionAPI } from '../types'
import { MattingModelField } from './imageGenMatting'
import { SettingsFooter, StyleField, WorkflowField } from './imageGenSettings'

export const imageModes = () =>
  [
    ['character', t('角色（全身）')],
    ['face', t('角色（脸部特写）')],
    ['user', t('用户（人设）')],
    ['scene', t('当前场景')],
    ['last', t('最后一条消息')],
    ['message', t('指定消息')],
    ['raw_last', t('最后一条消息原文')],
    ['background', t('背景')],
    ['free', t('自由描述…')],
  ] as const
const buttonClass = 'rounded px-3 py-1.5 text-left text-sm hover:bg-zinc-500/10 disabled:opacity-50'
interface Preview {
  snapshotId: string
  prompt: string
  negative: string
  width: number
  height: number
  source: string
  model: string
  workflow: string
}
interface GalleryImage {
  chatId: string
  messageId: string
  image: AttachmentDTO
  prompt: string
  createdAt: number
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export default function activate(api: ClientExtensionAPI) {
  const R = api.React
  const h = R.createElement
  async function request(path: string, body?: unknown) {
    const response = await api.fetchServer(
      path,
      body === undefined
        ? undefined
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    )
    const data = await response.json()
    if (!response.ok) throw new Error(data.error?.message ?? t('图片接口 HTTP {status}', { status: response.status }))
    return data as {
      message?: MessageDTO
      background?: unknown
      image?: AttachmentDTO
      durationMs?: number
      options?: { value: string; label: string }[]
      images?: GalleryImage[]
      total?: number
      error?: string
      placeholders?: { name: string; used: boolean }[]
      schedulers?: { value: string; label: string }[]
      adetailer?: boolean
      messageText?: string
    }
  }
  async function refresh(chatId: string, backgrounds = false) {
    await Promise.all([
      api.queryClient.invalidateQueries({ queryKey: ['chat', chatId] }),
      ...(backgrounds ? [api.queryClient.invalidateQueries({ queryKey: ['backgrounds'] })] : []),
    ])
  }
  const reviews = new Map<
    string,
    { chatId: string; preview: Preview; resolve: (value: { prompt: string; negative: string } | null) => void }
  >()
  const active = new Map<string, number>()
  const listeners = new Set<() => void>()
  function countRequest(chatId: string, delta: number) {
    active.set(chatId, (active.get(chatId) ?? 0) + delta)
    for (const listener of listeners) listener()
  }
  async function generate(chatId: string, mode: string, extra: Record<string, unknown> = {}) {
    const name = imageModes().find(([key]) => key === mode)?.[1] ?? mode
    countRequest(chatId, 1)
    try {
      const settings = await api.getSettings()
      if (settings.async === false || mode === 'background') api.toast.info(t('正在生成：{name}…', { name }))
      let confirmed: Record<string, unknown> = {}
      if (settings.editBeforeGenerate === true) {
        const response = await api.fetchServer('prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId, mode, ...extra }),
        })
        const preview = (await response.json()) as Preview & { error?: { message: string } }
        if (!response.ok) throw new Error(preview.error?.message ?? t('提示词预览失败'))
        const id = preview.snapshotId
        const edited = await new Promise<{ prompt: string; negative: string } | null>((resolve) => {
          reviews.set(id, { chatId, preview, resolve })
          for (const listener of listeners) listener()
        })
        reviews.delete(id)
        for (const listener of listeners) listener()
        if (!edited) return
        confirmed = { ...edited, snapshotId: id }
      }
      const data = await request('generate', { chatId, mode, ...extra, ...confirmed })
      if (data.background) api.toast.info(t('已生成背景并设为聊天背景'))
      await refresh(chatId, !!data.background)
    } catch (error) {
      api.toast.error(t('{name}生成失败：{error}', { name, error: errorText(error) }))
    } finally {
      countRequest(chatId, -1)
    }
  }
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
      (notify) => api.queryClient.getQueryCache().subscribe(notify),
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
  function CharacterSection({
    character,
    save,
  }: {
    character: CharacterDTO
    save: (patch: { extensions: Record<string, unknown> }) => Promise<void>
  }) {
    const original = character.extensions.sd_character_prompt as { positive?: string; negative?: string } | undefined
    const [positive, setPositive] = R.useState(original?.positive ?? '')
    const [negative, setNegative] = R.useState(original?.negative ?? '')
    const [busy, setBusy] = R.useState(false)
    async function submit() {
      setBusy(true)
      try {
        await save({ extensions: { ...character.extensions, sd_character_prompt: { positive, negative } } })
        api.toast.info(t('已保存角色图片提示词'))
      } catch (error) {
        api.toast.error(errorText(error))
      } finally {
        setBusy(false)
      }
    }
    return h(
      'div',
      { className: 'flex flex-col gap-3' },
      h(
        'label',
        null,
        t('角色外貌提示词（英文关键词，会加在生成提示词前面，可以写 LoRA 如 <lora:xxx:0.8>）'),
        h('textarea', {
          'aria-label': t('角色外貌提示词'),
          className: 'mt-1 w-full rounded border bg-transparent p-2',
          rows: 4,
          value: positive,
          onChange: (event: { target: { value: string } }) => setPositive(event.target.value),
        }),
      ),
      h(
        'label',
        null,
        t('角色负面提示词'),
        h('textarea', {
          'aria-label': t('角色负面提示词'),
          className: 'mt-1 w-full rounded border bg-transparent p-2',
          rows: 3,
          value: negative,
          onChange: (event: { target: { value: string } }) => setNegative(event.target.value),
        }),
      ),
      h('button', { type: 'button', className: buttonClass, disabled: busy, onClick: submit }, t('保存图片提示词')),
    )
  }
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
  function ImageSettingsFooter(props: {
    settings: Record<string, unknown>
    onSettingsChange?: (settings: Record<string, unknown>) => void
  }) {
    const current = R.useRef(props)
    current.current = props
    const source = props.settings.source
    const url = props.settings.a1111Url
    const auth = props.settings.a1111Auth
    R.useEffect(() => {
      if (source !== 'a1111') return
      let active = true
      // 探测只修改草稿中的能力标记，不自动保存用户的设置。
      current.current.onSettingsChange?.({
        ...current.current.settings,
        a1111HasSchedulers: false,
        a1111HasADetailer: false,
      })
      void request('a1111/capabilities', { settings: current.current.settings })
        .then((result) => {
          if (!active) return
          current.current.onSettingsChange?.({
            ...current.current.settings,
            a1111HasSchedulers: !!result.schedulers?.length,
            a1111HasADetailer: result.adetailer === true,
          })
        })
        .catch(() => {
          // 测试连接按钮负责显示错误，能力探测失败时保留隐藏状态。
        })
      return () => {
        active = false
      }
    }, [source, url, auth])
    return h(SettingsFooter, { api, settings: props.settings })
  }
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
