import { expect, test } from 'bun:test'
import type { WIActivation } from '@ai-parter/shared'
import { applyLanguage, getLanguage } from './i18n'
import { promptSegmentLabel, wiActivationLabel } from './i18n-labels'

test('世界书原因随语言切换，保留关键词与组名参数', () => {
  const language = getLanguage()
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { lang: '' } } })
  const base: WIActivation = {
    entryId: 'entry',
    lorebookId: 'book',
    lorebookName: '',
    comment: '',
    position: 'before_char',
    reasonCode: 'constant',
    activated: true,
    tokens: 1,
  }
  try {
    applyLanguage('zh')
    expect(wiActivationLabel(base)).toBe('常驻')
    expect(wiActivationLabel({ ...base, reasonCode: 'keyword', reasonParams: { key: '龙' } })).toBe('关键词：龙')
    const segment = {
      source: 'main',
      label: '主提示词',
      labelCode: 'preset:main',
      role: 'system' as const,
      content: '',
      tokens: 0,
    }
    expect(promptSegmentLabel(segment)).toBe('主提示词')
    applyLanguage('en')
    expect(promptSegmentLabel(segment)).toBe('Main prompt')
    expect(promptSegmentLabel({ ...segment, label: '自定义' })).toBe('自定义')
    expect(promptSegmentLabel({ ...segment, labelCode: 'preset:custom' })).toBe('主提示词')
    expect(promptSegmentLabel({ ...segment, labelCode: undefined })).toBe('主提示词')
    expect(promptSegmentLabel({ ...segment, labelCode: 'history' })).toBe('History message')
    expect(promptSegmentLabel({ ...segment, labelCode: 'world_info', labelParams: { title: '龙' } })).toBe(
      'World info: 龙',
    )

    expect(wiActivationLabel(base)).toBe('Always active')
    expect(wiActivationLabel({ ...base, reasonCode: 'keyword', reasonParams: { key: '龙' } })).toBe('Keyword: 龙')
    expect(wiActivationLabel({ ...base, reasonCode: 'recursive', reasonParams: { key: 'sea' } })).toBe('Recursion: sea')
    expect(wiActivationLabel({ ...base, activated: false, skippedCode: 'group', skippedParams: { group: '甲' } })).toBe(
      'Inclusion group: 甲',
    )
    for (const skippedCode of ['no_match', 'cooldown', 'budget', 'probability', 'delay'] as const)
      expect(wiActivationLabel({ ...base, activated: false, skippedCode })).not.toMatch(/[\u4e00-\u9fff]/)
    expect(wiActivationLabel({ ...base, reasonCode: 'none' })).toBe('')
  } finally {
    applyLanguage(language)
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})
