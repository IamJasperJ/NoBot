import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readZip } from '../src/lib/zip'
import { makeZip } from './helpers/zip'

const data = new TextEncoder().encode('中文内容')
test('ZIP：stored、deflate、UTF-8、目录与危险路径', () => {
  const zip = makeZip([
    { path: 'joy.png', data },
    { path: '礼服/sadness.png', data, method: 8 },
    { path: '目录/', data: new Uint8Array() },
    { path: '../evil', data },
    { path: '/absolute', data },
    { path: '无标志.txt', data, flags: 0 },
  ])
  expect(readZip(zip).map((entry) => entry.path)).toEqual(['joy.png', '礼服/sadness.png', '无标志.txt'])
  for (const entry of readZip(zip)) expect(entry.data).toEqual(data)
})
test('ZIP：拒绝损坏、加密、ZIP64、未知压缩与超限', () => {
  expect(() => readZip(new Uint8Array())).toThrow('中央目录')
  expect(() => readZip(makeZip([{ path: 'a', data, flags: 1 }]))).toThrow('加密')
  expect(() => readZip(makeZip([{ path: 'a', data, method: 99 }]))).toThrow('压缩方式')
  const zip64 = makeZip([{ path: 'a', data }])
  zip64.writeUInt32LE(0xffffffff, zip64.length - 6)
  expect(() => readZip(zip64)).toThrow('ZIP64')
  const large = makeZip([{ path: 'a', data }])
  large.writeUInt32LE(31 * 1024 * 1024, 30 + 1 + data.length + 24)
  expect(() => readZip(large)).toThrow('大小')
  const many = makeZip(Array.from({ length: 2001 }, () => ({ path: 'a', data })))
  expect(() => readZip(many)).toThrow('2000')
})
test.skipIf(!Bun.which('zip'))('ZIP：系统 zip 打包兼容', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vn2-zip-'))
  try {
    await Bun.write(join(directory, '中文.txt'), '测试内容'.repeat(100))
    const result = Bun.spawnSync(['zip', 'pack.zip', '中文.txt'], { cwd: directory })
    expect(result.exitCode).toBe(0)
    const entries = readZip(new Uint8Array(await Bun.file(join(directory, 'pack.zip')).arrayBuffer()))
    expect(entries[0]?.path).toBe('中文.txt')
    expect(new TextDecoder().decode(entries[0]!.data)).toBe('测试内容'.repeat(100))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('ZIP：latin1 回退、UTF-8 标志及总解压上限', () => {
  const latin = makeZip([{ path: 'x.txt', data, flags: 0 }])
  const central = 30 + 5 + data.length
  latin[30] = 0xe9
  latin[central + 46] = 0xe9
  expect(readZip(latin)[0]?.path).toBe('é.txt')
  latin.writeUInt16LE(0x800, central + 8)
  expect(() => readZip(latin)).toThrow('UTF-8')
  const bomb = makeZip(Array.from({ length: 11 }, () => ({ path: 'x', data })))
  let offset = 11 * (31 + data.length)
  for (let i = 0; i < 11; i++) {
    bomb.writeUInt32LE(30 * 1024 * 1024, offset + 24)
    // 目录条目不解压，仍计入总量，避免通过目录名绕过资源限制。
    bomb[offset + 46] = 47
    offset += 47
  }
  expect(() => readZip(bomb)).toThrow('大小')
  const mismatch = makeZip([{ path: 'x', data, method: 8 }])
  mismatch.writeUInt32LE(0, mismatch.length - 22 - 47 + 24)
  expect(() => readZip(mismatch)).toThrow('解压')
})
