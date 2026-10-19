import { expect, test } from 'bun:test'
import { migrateLocalStorage } from './migrate-local-storage'

function memoryStorage(values: Record<string, string>) {
  const data = new Map(Object.entries(values))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
    removeItem: (key: string) => {
      data.delete(key)
    },
  }
}

test('搬迁所有本机偏好，保留新键，重复执行不改变结果', () => {
  const storage = memoryStorage({ unrelated: '保留' })
  for (const suffix of ['language', 'appearance', 'sprite-layout', 'selection']) {
    storage.setItem(`ai-parter:${suffix}`, `旧值:${suffix}`)
  }
  storage.setItem('nobot:language', 'en')
  storage.setItem('nobot:selection', '')
  migrateLocalStorage(storage)
  const expected = new Map([
    ['unrelated', '保留'],
    ['nobot:language', 'en'],
    ['nobot:selection', ''],
    ['nobot:appearance', '旧值:appearance'],
    ['nobot:sprite-layout', '旧值:sprite-layout'],
  ])
  expect(storage.data).toEqual(expected)
  migrateLocalStorage(storage)
  expect(storage.data).toEqual(expected)
})

test('写入失败时保留旧值，之后可以重试', () => {
  const storage = memoryStorage({ 'ai-parter:language': 'zh' })
  migrateLocalStorage({
    ...storage,
    setItem: () => {
      throw new Error('存储不可用')
    },
  })
  expect(storage.getItem('ai-parter:language')).toBe('zh')
  migrateLocalStorage(storage)
  expect(storage.getItem('nobot:language')).toBe('zh')
  expect(storage.getItem('ai-parter:language')).toBeNull()
  expect(() =>
    migrateLocalStorage({
      ...storage,
      getItem: () => {
        throw new Error('存储不可用')
      },
    }),
  ).not.toThrow()
})
