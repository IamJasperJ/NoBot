/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { type LorebookDTO, lorebookEntryDataSchema, worldInfoSettingsSchema } from '@ai-parter/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BookEditor } from './BookEditor'
import { EntryEditor } from './EntryEditor'
import { SettingsEditor } from './SettingsEditor'

const noop = () => {}
const guard = { current: () => true }
const book: LorebookDTO = {
  id: 'book',
  name: '测试世界书',
  description: '',
  isGlobal: false,
  entryCount: 500,
  updatedAt: 0,
}

function render(node: ReactNode) {
  return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>)
}

function renderEntry(data = lorebookEntryDataSchema.parse({})) {
  return render(
    <EntryEditor draft={data} onChange={noop} dirty={false} pending={false} save={noop} reset={noop} remove={noop} />,
  )
}

describe('世界书编辑器', () => {
  test('大量折叠条目只输出摘要，不挂载内容编辑器', () => {
    const entries = Array.from({ length: 500 }, (_, i) => ({
      ...lorebookEntryDataSchema.parse({
        comment: `条目${i}`,
        keys: ['龙', '城堡', '魔法', '隐藏关键词'],
        content: '不应渲染的编辑器内容',
      }),
      id: `entry-${i}`,
      lorebookId: book.id,
    }))
    const html = render(<BookEditor book={book} entries={entries} guard={guard} onBack={noop} onDeleted={noop} />)
    expect(html.match(/<article /g)?.length).toBe(500)
    expect(html.match(/<textarea/g)?.length).toBe(1)
    expect(html).not.toContain('不应渲染的编辑器内容')
    expect(html).toContain('龙、城堡、魔法')
    expect(html).not.toContain('隐藏关键词')
  })

  test('未命名条目依次使用第一个关键词和默认标题', () => {
    const entries = ['', '第一关键词'].map((key, i) => ({
      ...lorebookEntryDataSchema.parse({ keys: key ? [key] : [] }),
      id: String(i),
      lorebookId: book.id,
    }))
    const html = render(<BookEditor book={book} entries={entries} guard={guard} onBack={noop} onDeleted={noop} />)
    expect(html).toContain('未命名条目')
    expect(html).toContain('第一关键词')
  })

  test('插入位置只显示适用的深度、角色或宏引用字段', () => {
    const normal = renderEntry()
    expect(normal).not.toContain('插入深度')
    expect(normal).not.toContain('消息角色')
    expect(normal).not.toContain('宏引用名字')
    const depth = renderEntry(lorebookEntryDataSchema.parse({ position: 'at_depth', depth: 8, role: 'user' }))
    expect(depth).toContain('插入深度')
    expect(depth).toContain('消息角色')
    expect(depth).not.toContain('宏引用名字')
    const outlet = renderEntry(lorebookEntryDataSchema.parse({ position: 'outlet', outletName: '城市' }))
    expect(outlet).toContain('宏引用名字')
    expect(outlet).toContain('{{outlet::名字}}')
    expect(outlet).not.toContain('插入深度')
  })

  test('完整编辑器包含全部分组、三态继承、字数及五个未实现标记', () => {
    const html = renderEntry(lorebookEntryDataSchema.parse({ content: '龙🐉' }))
    for (const title of ['基本', '触发', '插入', '匹配', '递归', '包含组', '暂未实现']) expect(html).toContain(title)
    expect(html).toContain('字数：2')
    expect(html).toContain('value="inherit" selected=""')
    expect(html).toContain('placeholder="跟随全局" value=""')
    expect(html.match(/>未实现<\/span>/g)?.length).toBe(5)
    expect(html).toMatch(/<details class="[^"]*"><summary[^>]*>.*?暂未实现/)
    expect(html).toContain('都不选表示全部类型')
  })

  test('全局设置包括预算、递归、来源排序和未实现的最少激活数', () => {
    const html = render(<SettingsEditor settings={worldInfoSettingsSchema.parse({})} guard={guard} onBack={noop} />)
    for (const text of [
      '扫描深度',
      '预算比例',
      '预算上限',
      '包含发言人名字',
      '递归扫描',
      '最大递归轮数',
      '区分大小写',
      '完整单词匹配',
      '多个来源的排序方式',
      '最少激活数',
    ])
      expect(html).toContain(text)
    for (const value of ['evenly', 'character_first', 'global_first']) expect(html).toContain(`value="${value}"`)
    expect(html.match(/>未实现<\/span>/g)?.length).toBe(1)
  })
})
