import { expect, test } from 'bun:test'
import regex from '../regex'
import { settingsSchema } from './settings'

test('图片设置声明附着请求头、列表标题和默认收起分组', () => {
  expect(settingsSchema.find((field) => field.key === 'comfyHeaders')).toMatchObject({
    type: 'textarea',
    label: '附加请求头（JSON）',
    attachTo: 'comfyUrl',
    attachLabel: '头',
    hint: expect.stringContaining('{"Authorization": "Bearer xxx"}'),
    visibleWhen: { key: 'source', equals: 'comfy' },
  })
  for (const [key, titleKey] of [
    ['styles', 'name'],
    ['modeOverrides', 'mode'],
    ['comfyWorkflows', 'name'],
    ['comfyCustomPlaceholders', 'find'],
  ]) {
    expect(settingsSchema.find((field) => field.key === key)).toMatchObject({ type: 'list', titleKey })
  }
  for (const key of ['interaction', 'templates', 'comfyAdvanced']) {
    expect(settingsSchema.find((field) => field.key === key)).toMatchObject({ type: 'heading', defaultCollapsed: true })
  }
  expect(regex.settingsSchema?.find((field) => field.key === 'scripts')).toMatchObject({
    type: 'list',
    titleKey: 'name',
  })
})
