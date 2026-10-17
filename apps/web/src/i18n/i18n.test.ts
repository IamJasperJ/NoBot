import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { en } from './en'

/** 扫描前端源码里所有 t('…') 的键，确认都有英文翻译、占位符一致 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    // i18n 目录自己的注释里有示例键，不算
    if (statSync(path).isDirectory()) return name === 'i18n' ? [] : sources(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

const root = join(import.meta.dir, '..')
const KEY = /(?<![\w.])t\(\s*'((?:[^'\\\n]|\\.)*)'/g
const keys = new Map<string, string>()
for (const file of sources(root)) {
  for (const match of readFileSync(file, 'utf8').matchAll(KEY)) {
    const key = (match[1] as string).replace(/\\(.)/g, '$1')
    if (!keys.has(key)) keys.set(key, file.slice(root.length + 1))
  }
}
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('界面双语', () => {
  test('每个 t() 的键都有英文', () => {
    const missing = [...keys].filter(([key]) => !(key in en)).map(([key, file]) => `${file}: ${key}`)
    expect(missing).toEqual([])
  })
  test('英文里的占位符和中文一致', () => {
    const wrong = Object.entries(en)
      .filter(([zh, text]) => placeholders(zh).join() !== placeholders(text).join())
      .map(([zh]) => zh)
    expect(wrong).toEqual([])
  })
  test('英文里没有用不到的键', () => {
    expect(Object.keys(en).filter((key) => !keys.has(key))).toEqual([])
  })
})
