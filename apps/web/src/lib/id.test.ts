import { describe, expect, spyOn, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomId } from './id'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('randomId', () => {
  test('有 randomUUID 时直接用', () => {
    expect(randomId()).toMatch(UUID_V4)
  })

  test('http 访问没有 randomUUID 时用 getRandomValues 拼出 v4 格式', () => {
    const original = crypto.randomUUID
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
    const values = spyOn(crypto, 'getRandomValues')
    try {
      const ids = new Set(Array.from({ length: 50 }, () => randomId()))
      expect(ids.size).toBe(50)
      for (const id of ids) expect(id).toMatch(UUID_V4)
      expect(values).toHaveBeenCalled()
    } finally {
      values.mockRestore()
      Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true })
    }
  })

  // 防止以后又直接调用只在安全上下文里有的接口，导致用 http + IP 访问时报错
  test('前端代码不直接调用 crypto.randomUUID / crypto.subtle', () => {
    const root = join(import.meta.dir, '..')
    const allowed = new Set([join(root, 'lib/id.ts'), join(root, 'api/translation.ts')])
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !allowed.has(path))
          if (/crypto\.(randomUUID|subtle)\b/.test(readFileSync(path, 'utf8'))) offenders.push(path)
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})
