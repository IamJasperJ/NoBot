import { expect, test } from 'bun:test'
import { resolveBackgroundId } from './backgrounds'

test('背景解析保留固定与舞台层的位置，依次回退到角色或群组默认、全局和空背景', () => {
  const layers = { backgroundId: 'chat', stageBackgroundId: 'stage', defaultBackgroundId: 'owner', globalId: 'global' }
  expect(resolveBackgroundId({ ...layers, backgroundPinned: true })).toBe('chat')
  expect(resolveBackgroundId(layers)).toBe('stage')
  expect(resolveBackgroundId({ ...layers, stageBackgroundId: null })).toBe('chat')
  expect(resolveBackgroundId({ ...layers, stageBackgroundId: null, backgroundId: null })).toBe('owner')
  expect(resolveBackgroundId({ globalId: 'global', backgroundPinned: true })).toBe('global')
  expect(resolveBackgroundId({})).toBeNull()
})
