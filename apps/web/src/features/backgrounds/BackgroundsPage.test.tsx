import { expect, test } from 'bun:test'
import type { BackgroundDTO } from '@ai-parter/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { keys } from '../../api/queries'
import { DEFAULT_APPEARANCE } from '../../stores/appearance'
import { SettingsPage } from '../settings/SettingsPage'
import { BackgroundsPage } from './BackgroundsPage'

test('背景库展示视频缩略图、GIF 缩略图、动态角标和最新排序', () => {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } } })
  const base: BackgroundDTO = {
    id: 'static',
    name: '静态风景',
    url: '/static.webp',
    thumbUrl: '/static.thumb.webp',
    width: 640,
    height: 480,
    source: 'upload',
    mime: 'image/webp',
    animated: false,
    createdAt: 1,
  }
  qc.setQueryData(keys.backgrounds, [
    base,
    {
      ...base,
      id: 'gif',
      name: '动态森林',
      url: '/forest.gif',
      thumbUrl: '/forest.thumb.webp',
      mime: 'image/gif',
      animated: true,
      createdAt: 2,
    },
    {
      ...base,
      id: 'video',
      name: '动态海边',
      url: '/sea.mp4',
      thumbUrl: '/sea.mp4',
      mime: 'video/mp4',
      animated: true,
      createdAt: 3,
    },
  ])
  qc.setQueryData(keys.backgroundSettings, { globalId: null })
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <BackgroundsPage />
      </QueryClientProvider>,
    )
    expect(html).toContain('accept="image/*,video/mp4,video/webm"')
    expect(html).toContain('<video')
    expect(html).toContain('preload="metadata"')
    expect(html).toContain('/sea.mp4')
    expect(html).toContain('/forest.thumb.webp')
    expect(html).not.toContain('src="/forest.gif"')
    expect(html.match(/>动态<\/span>/g)).toHaveLength(2)
    expect(html.indexOf('title="动态海边"')).toBeLessThan(html.indexOf('title="动态森林"'))
    expect(html.indexOf('title="动态森林"')).toBeLessThan(html.indexOf('title="静态风景"'))
    for (const label of ['搜索背景', '最新', '名字', '从网址添加']) expect(html).toContain(label)
  } finally {
    qc.clear()
  }
})

test('设置提供四种填充方式，动态背景默认播放', () => {
  expect(DEFAULT_APPEARANCE.bgAnimate).toBe(true)
  // 设置页现在带玩法预设列表（要查询数据），给一个空的 QueryClient
  const qc = new QueryClient()
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SettingsPage />
    </QueryClientProvider>,
  )
  qc.clear()
  for (const label of ['铺满裁剪', '完整显示', '拉伸', '居中原尺寸', '播放动态背景']) expect(html).toContain(label)
  for (const value of ['cover', 'contain', 'stretch', 'center']) expect(html).toContain(`value="${value}"`)
})
