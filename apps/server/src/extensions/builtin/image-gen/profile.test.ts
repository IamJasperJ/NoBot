import { expect, spyOn, test } from 'bun:test'
import { profileImageSchema } from '@nobot/shared'
import { applyProfileImage } from './profile'
import { parseSettings } from './settings'

test('四种后端覆盖连接、地址、模型、工作流和风格，且不修改输入', () => {
  const settings = parseSettings({
    openaiConnectionId: 'extension',
    openrouterConnectionId: 'extension',
    comfyWorkflowName: 'saved',
    styles: [{ name: 'test' }],
  })
  const original = structuredClone(settings)
  for (const source of ['openai', 'openrouter', 'comfy', 'a1111'] as const) {
    const result = applyProfileImage(settings, {
      image: profileImageSchema.parse({
        source,
        connectionId: 'profile',
        url: 'http://profile',
        model: 'chosen',
        comfyWorkflow: '',
        style: 'test',
      }),
      promptConnectionId: 'prompt',
    })
    expect(result).toMatchObject({ source, activeStyle: 'test', promptConnectionId: 'prompt' })
    if (source === 'openai' || source === 'openrouter') {
      expect(result[`${source}ConnectionId`]).toBe('profile')
      expect(result[`${source}Model`]).toBe('chosen')
    } else if (source === 'comfy') {
      expect(result).toMatchObject({ comfyUrl: 'http://profile', comfyCheckpoint: 'chosen', comfyWorkflowName: '' })
    } else expect(result).toMatchObject({ a1111Url: 'http://profile', a1111Model: 'chosen' })
  }
  expect(settings).toEqual(original)
})

test('空字段继承扩展，空图片覆盖保持设置，提示词连接只填空', () => {
  for (const source of ['openai', 'openrouter', 'comfy', 'a1111'] as const) {
    const settings = parseSettings({
      source,
      openaiConnectionId: 'saved',
      openrouterConnectionId: 'saved',
      promptConnectionId: 'extension',
      comfyWorkflowName: 'custom',
    })
    expect(
      applyProfileImage(settings, { image: profileImageSchema.parse({ source }), promptConnectionId: 'profile' }),
    ).toEqual(settings)
    expect(applyProfileImage(settings, { image: null, promptConnectionId: 'profile' })).toEqual(settings)
    expect(applyProfileImage(settings, null)).toEqual(settings)
    expect(
      applyProfileImage(settings, {
        image: profileImageSchema.parse({ source, connectionId: '' }),
        promptConnectionId: null,
      }),
    ).toEqual(settings)
  }
})

test('不存在的风格忽略并警告', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const settings = parseSettings({})
    expect(
      applyProfileImage(settings, {
        image: profileImageSchema.parse({ source: 'openai', style: 'missing' }),
        promptConnectionId: null,
      }).activeStyle,
    ).toBe(settings.activeStyle)
    expect(warn).toHaveBeenCalledTimes(1)
  } finally {
    warn.mockRestore()
  }
})
