import { expect, test } from 'bun:test'
import { restoreSecrets, SECRET_MASK } from '../src/extensions/types'

test('草稿里的密钥占位串换回保存的原值，改过的值保留', () => {
  const saved = { apiKey: 'sk-real', other: 'x' }
  expect(restoreSecrets({ apiKey: SECRET_MASK, other: 'y' }, saved)).toEqual({ apiKey: 'sk-real', other: 'y' })
  expect(restoreSecrets({ apiKey: 'sk-new' }, saved)).toEqual({ apiKey: 'sk-new' })
  expect(restoreSecrets({ missing: SECRET_MASK }, saved)).toEqual({ missing: '' })
})
