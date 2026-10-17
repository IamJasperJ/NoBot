/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test'
import { type CharacterDTO, characterInput, type LorebookDTO, type PersonaDTO } from '@ai-parter/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { keys } from '../../api/queries'
import { useUi } from '../../stores/ui'
import { GroupDialog } from '../groups/GroupDialog'
import { PersonasPage } from '../personas/PersonasPage'
import { CharacterEditor, CharactersPage } from './CharactersPage'
import { CountedArea, moveItem } from './editor'

const character: CharacterDTO = {
  ...characterInput.parse({
    name: '测试角色',
    description: '角色描述',
    alternate_greetings: ['在城堡见面', '在森林见面'],
    lorebookIds: ['second', 'first'],
    defaultPersonaId: 'persona',
  }),
  id: 'character',
  avatarUrl: null,
  createdAt: 0,
  updatedAt: 0,
}
const persona: PersonaDTO = {
  id: 'persona',
  name: '测试人设',
  description: '',
  avatarUrl: null,
  lorebookId: null,
  isDefault: true,
}
const books: LorebookDTO[] = ['first', 'second'].map((id) => ({
  id,
  name: `世界书-${id}`,
  description: '',
  isGlobal: false,
  entryCount: 0,
  updatedAt: 0,
}))
const noop = () => {}

function render(node: ReactNode, populated = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  client.setQueryData(keys.characters, populated ? [character] : [])
  client.setQueryData(keys.personas, populated ? [persona] : [])
  client.setQueryData(keys.lorebooks, books)
  client.setQueryData(keys.character(character.id), character)
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

afterEach(() => {
  useUi.getInitialState().focusId = null
  useUi.setState({ focusId: null })
})

describe('E3 管理界面', () => {
  test('聊天页 focusId 高亮侧栏中的角色，编辑器不再内联到列表', () => {
    // 服务端渲染使用 Zustand 的初始快照，预置它来模拟从聊天页进入。
    useUi.getInitialState().focusId = character.id
    const html = render(<CharactersPage />)
    expect(html).toContain('bg-violet-100 dark:bg-violet-950')
    expect(html).toContain('测试角色')
    expect(html).toContain('accept=".png,.json,.charx" multiple=""')
    expect(html).not.toContain('基础设定')
  })

  test('角色编辑器保留所有设定分组和开场白字段', () => {
    const html = render(<CharacterEditor character={character} onBack={noop} onDirty={noop} onSelect={noop} />)
    for (const text of [
      '基础设定',
      '进阶设定',
      '角色备注',
      '群聊',
      '关联',
      '在城堡见面',
      '在森林见面',
      '导出 PNG',
      '导出 JSON',
      '开始聊天',
    ])
      expect(html).toContain(text)
    expect(html).toContain('accept="image/*"')
    expect(html).toContain('rows="8"')
    expect(html).toContain('rows="6"')
    expect(html).toContain('第一本是导出角色卡时嵌入的主世界书')
    expect(html.indexOf('世界书-second')).toBeLessThan(html.indexOf('世界书-first'))
    expect(html).toContain('value="persona" selected=""')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>保存<\/button>/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>撤销修改<\/button>/)
  })

  test('角色和人设空列表提供创建引导，人设列表显示默认标记', () => {
    expect(render(<CharactersPage />, false)).toContain('点击「新建」或「导入」添加第一个角色')
    expect(render(<PersonasPage />, false)).toContain('点击「新建」添加一个用户人设')
    const html = render(<PersonasPage />)
    expect(html).toContain('测试人设')
    expect(html).toContain('>默认</span>')
  })

  test('新群组显示全部发言模式和未实现标记，空成员时禁止保存', () => {
    const html = render(<GroupDialog open groupId={null} onClose={noop} onSaved={noop} />)
    for (const text of [
      '自然顺序',
      '列表顺序',
      '轮流随机',
      '手动点名',
      '只用当前发言者的角色卡',
      '合并全部成员的角色卡',
      '合并全部成员（含静音）',
      '允许回应自己',
      '自动模式',
      '未实现',
      '场景覆盖',
      '测试角色',
    ])
      expect(html).toContain(text)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>保存<\/button>/)
    expect(html).not.toContain('删除群组')
    expect(html).toContain('至少一位成员')
    expect(render(<GroupDialog open={false} groupId={null} onClose={noop} onSaved={noop} />)).not.toContain('场景覆盖')
  })

  test('角色列表搜索和单行字段不显示字数提示', () => {
    const html = render(<CharactersPage />)
    expect(html).toContain('搜索角色')
    expect(html).not.toContain('估算字数')
  })

  test('文本字数按 content.length 估算，保留宏和多行内容', () => {
    const content = '龙🐉\n{{char}}'
    const html = render(<CountedArea label="内容" hint="测试说明" value={content} onChange={noop} />)
    expect(html).toContain(`估算字数：${content.length}`)
    expect(html).toContain(content)
  })

  test('调整顺序保留成员静音状态，且不会改变原草稿', () => {
    const members = [
      { characterId: 'one', muted: true },
      { characterId: 'two', muted: false },
      { characterId: 'three', muted: false },
    ]
    const before = structuredClone(members)
    const moved = moveItem(members, 0, 1)
    expect(moved.map((m) => m.characterId)).toEqual(['two', 'one', 'three'])
    expect(moved[1]?.muted).toBe(true)
    expect(moveItem(moved, 1, -1)).toEqual(before)
    expect(members).toEqual(before)
    expect(moveItem(members, 0, -1)).toEqual(before)
    expect(moveItem(members, 2, 1)).toEqual(before)
  })
})

test('角色编辑插槽使用折叠分组，保存仅浅合并 extensions 并保留其他表单字段', async () => {
  const { spyOn } = await import('bun:test')
  const { api } = await import('../../api/client')
  const { useExtensionsRuntime } = await import('../../extensions/runtime')
  let save: ((patch: { extensions: Record<string, unknown> }) => Promise<void>) | undefined
  const latest = { ...character, extensions: { other: true, nested: { before: true } } }
  const get = spyOn(api, 'getCharacter').mockResolvedValue(latest)
  const update = spyOn(api, 'updateCharacter').mockResolvedValue({
    ...latest,
    extensions: { other: true, nested: { after: true } },
  })
  const slots = [
    {
      slot: 'character.editor.sections' as const,
      id: 'image-config',
      title: '角色图片配置',
      order: 100,
      extensionId: 'fixture',
      render: (props: never) => {
        save = (props as { save: NonNullable<typeof save> }).save
        return <span>图片生成提示词</span>
      },
    },
  ]
  useExtensionsRuntime.getInitialState().slots = slots
  try {
    const html = render(<CharacterEditor character={character} onBack={noop} onDirty={noop} onSelect={noop} />)
    expect(html).toContain('角色图片配置')
    expect(html).toContain('图片生成提示词')
    const lastGroup = html.slice(html.lastIndexOf('<details'), html.indexOf('>', html.lastIndexOf('<details')))
    expect(lastGroup).not.toContain('open=')
    expect(save).toBeDefined()
    await save?.({ extensions: { nested: { after: true } } })
    expect(update).toHaveBeenCalledWith(character.id, { extensions: { other: true, nested: { after: true } } })
  } finally {
    get.mockRestore()
    update.mockRestore()
    useExtensionsRuntime.getInitialState().slots = []
  }
})
