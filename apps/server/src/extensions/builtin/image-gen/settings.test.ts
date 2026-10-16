import { expect, test } from 'bun:test'
import regex from '../regex'
import { settingsSchema } from './settings'

test('图片设置声明附着请求头、列表标题和默认收起分组', () => {
  expect(settingsSchema.find((field) => field.key === 'comfyHeaders')).toMatchObject({
    type: 'textarea',
    label: '额外请求头（JSON）',
    attachTo: 'comfyUrl',
    attachLabel: '额外请求头',
    hint: expect.stringContaining('{"Authorization": "Bearer xxx"}'),
    visibleWhen: { key: 'source', equals: 'comfy' },
  })
  // OpenAI 兼容接口也有额外请求头，附着在「复用连接」右边；地址和密钥只在 OpenAI + 自定义时显示
  expect(settingsSchema.find((field) => field.key === 'openaiHeaders')).toMatchObject({
    attachTo: 'openaiConnectionId',
    attachLabel: '额外请求头',
  })
  for (const key of ['openaiBaseUrl', 'openaiApiKey'])
    expect(settingsSchema.find((field) => field.key === key)?.visibleWhen).toEqual([
      { key: 'source', equals: 'openai' },
      { key: 'openaiConnectionId', equals: '' },
    ])
  expect(settingsSchema.some((field) => field.key === 'openaiImageOnly')).toBe(false)
  for (const [key, titleKey] of [['modeOverrides', 'mode']]) {
    expect(settingsSchema.find((field) => field.key === key)).toMatchObject({ type: 'list', titleKey })
  }
  expect(settingsSchema.find((field) => field.key === 'activeStyle')).toMatchObject({ type: 'custom' })
  expect(settingsSchema.find((field) => field.key === 'comfyWorkflowName')).toMatchObject({ type: 'custom' })
  for (const key of ['interaction', 'templates']) {
    expect(settingsSchema.find((field) => field.key === key)).toMatchObject({ type: 'heading', defaultCollapsed: true })
  }
  expect(regex.settingsSchema?.find((field) => field.key === 'scripts')).toMatchObject({
    type: 'list',
    titleKey: 'name',
  })
})
