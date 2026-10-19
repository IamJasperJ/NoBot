import { expect, spyOn, test } from 'bun:test'
import { type ChatPage, characterInput } from '@nobot/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { api } from './client'
import { keys, refreshChatState, useResolvedBackgroundId } from './queries'

function page(): ChatPage {
  return {
    chat: {
      id: 'chat',
      characterId: 'actor',
      groupId: null,
      title: 'test',
      updatedAt: 1,
      createdAt: 1,
      personaId: null,
      activeLeafId: null,
      apiPresetId: null,
      promptPresetId: null,
      profileId: null,
      playPresetId: null,
      authorNote: '',
      authorNoteDepth: 4,
      authorNoteRole: 'system',
      lorebookIds: [],
      backgroundId: null,
      backgroundPinned: false,
      autoBackground: { lore: false, everyN: 0 },
    },
    group: null,
    messages: [],
    hasMore: false,
    generating: false,
    vars: {},
    stage: null,
    playPresetId: 'play',
    stateSchema: {},
  }
}

test('背景数据 hook：单聊读取角色默认值，群聊读取群组默认值，再回退全局', () => {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } } })
  const current = page()
  const cache = () => qc.setQueryData(keys.chat('chat'), { pages: [current], pageParams: [undefined] })
  qc.setQueryData(keys.character('actor'), {
    ...characterInput.parse({ name: 'Alice' }),
    id: 'actor',
    defaultBackgroundId: 'actor-bg',
    avatarUrl: null,
    createdAt: 1,
    updatedAt: 1,
  })
  qc.setQueryData(keys.backgroundSettings, { globalId: 'global' })
  function Result() {
    return <span>{useResolvedBackgroundId('chat')}</span>
  }
  const render = () =>
    renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <Result />
      </QueryClientProvider>,
    )
  cache()
  expect(render()).toBe('<span>actor-bg</span>')
  current.chat = { ...current.chat, characterId: null, groupId: 'group' }
  current.group = {
    id: 'group',
    name: 'Party',
    defaultBackgroundId: 'group-bg',
    activation: 'natural',
    generationMode: 'swap',
    allowSelfResponses: false,
    autoMode: false,
    scenarioOverride: '',
    members: [],
    updatedAt: 1,
  }
  cache()
  expect(render()).toBe('<span>group-bg</span>')
  current.group.defaultBackgroundId = null
  cache()
  expect(render()).toBe('<span>global</span>')
  qc.clear()
})

test('生成完成后更新所有分页的会话背景与自动设置，并保留已加载消息', async () => {
  const qc = new QueryClient()
  const old = page()
  const latest = page()
  latest.chat.backgroundId = 'changed'
  latest.chat.autoBackground = { lore: true, everyN: 3 }
  const mock = spyOn(api, 'getChatPage').mockResolvedValue(latest)
  qc.setQueryData(keys.chat('chat'), { pages: [old, { ...old, hasMore: true }], pageParams: [undefined, 'before'] })
  try {
    await refreshChatState(qc, 'chat')
    const cached = qc.getQueryData<{ pages: ChatPage[] }>(keys.chat('chat'))!
    expect(cached.pages).toHaveLength(2)
    for (const item of cached.pages) {
      expect(item.chat.backgroundId).toBe('changed')
      expect(item.chat.autoBackground).toEqual({ lore: true, everyN: 3 })
      expect(item.messages).toBe(old.messages)
    }
    expect(cached.pages[1]?.hasMore).toBe(true)
  } finally {
    mock.mockRestore()
    qc.clear()
  }
})
