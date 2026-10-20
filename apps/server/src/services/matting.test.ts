import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { createMattingService, type MattingOptions, type MattingRuntime } from './matting'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
const options: MattingOptions = {
  mode: 'model',
  backdrop: 'white',
  modelUrl: 'https://model.invalid/test',
  registry: 'https://registry.invalid',
}
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'matting-test-'))
  directories.push(dir)
  return dir
}
async function fakeRuntime(dir: string) {
  const pkg = join(dir, 'runtime/node_modules/onnxruntime-node')
  await mkdir(join(pkg, 'dist'), { recursive: true })
  await writeFile(join(pkg, 'package.json'), '{"main":"dist/index.js"}')
  await writeFile(join(pkg, 'dist/index.js'), 'export {}')
  for (const platform of ['darwin', 'linux', 'win32'])
    for (const arch of ['arm64', 'x64']) await mkdir(join(pkg, 'bin/napi-v6', platform, arch), { recursive: true })
}

test('安装去重、流式进度、磁盘状态和卸载拒绝正在进行的安装', async () => {
  const dir = await directory()
  let calls = 0
  let spawned = 0
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const service = createMattingService({
    directory: dir,
    fetch: async () => {
      calls++
      return new Response(
        new ReadableStream({
          start(c) {
            controller = c
          },
        }),
        { headers: { 'content-length': '4' } },
      )
    },
    spawn: async (args, cwd) => {
      spawned++
      expect(args).toEqual(['add', 'onnxruntime-node@1.30.0', '--registry', options.registry])
      expect(cwd).toBe(join(dir, 'runtime'))
      await fakeRuntime(dir)
    },
  })
  expect(await service.status()).toEqual({ runtime: { state: 'missing' }, model: { state: 'missing' } })
  await Promise.all([service.install(options), service.install(options)])
  // 进程启动发生在创建目录之后，通过状态而非固定延时等待。
  for (let i = 0; i < 1000 && (!spawned || !calls); i++) await Bun.sleep(1)
  expect(calls).toBe(1)
  expect(spawned).toBe(1)
  await expect(service.remove()).rejects.toThrow()
  controller.enqueue(new Uint8Array([1, 2]))
  await Bun.sleep(5)
  expect((await service.status()).model).toMatchObject({ state: 'installing', received: 2, total: 4 })
  controller.enqueue(new Uint8Array([3, 4]))
  controller.close()
  await service.waitForInstall()
  expect(await service.status()).toEqual({ runtime: { state: 'ready' }, model: { state: 'ready' } })
  expect(await createMattingService({ directory: dir }).status()).toEqual(await service.status())
  await service.install(options)
  expect(calls).toBe(1)
  expect(spawned).toBe(1)
  expect(await service.remove()).toEqual({ runtime: { state: 'missing' }, model: { state: 'missing' } })
})

test('下载和运行时失败后重试，空模型不算已安装', async () => {
  const dir = await directory()
  let fail = true
  const service = createMattingService({
    directory: dir,
    fetch: async () => (fail ? new Response('', { status: 500 }) : new Response(new Uint8Array([1]))),
    spawn: async () => {
      if (fail) throw new Error('fake failure')
      await fakeRuntime(dir)
    },
  })
  await service.install(options)
  await service.waitForInstall()
  expect((await service.status()).runtime.state).toBe('error')
  expect((await service.status()).model.state).toBe('error')
  fail = false
  await service.install(options)
  await service.waitForInstall()
  expect((await service.status()).model.state).toBe('ready')
  await writeFile(join(dir, 'isnetis.onnx'), '')
  expect((await service.status()).model.state).toBe('missing')
})

test('假会话验证 NCHW、归一化、letterbox 裁切、遮罩回贴与会话缓存', async () => {
  const dir = await directory()
  await fakeRuntime(dir)
  await writeFile(join(dir, 'isnetis.onnx'), 'model')
  let loads = 0
  const fake: MattingRuntime = {
    Tensor: class {
      constructor(
        public type: 'float32',
        public data: Float32Array,
        public dims: number[],
      ) {}
    },
    InferenceSession: {
      create: async () => ({
        inputNames: ['input-custom'],
        outputNames: ['output-custom'],
        run: async (feeds) => {
          const tensor = feeds['input-custom']!
          expect(tensor.dims).toEqual([1, 3, 1024, 1024])
          expect(tensor.data[0]).toBe(0)
          expect(tensor.data[256 * 1024]).toBeCloseTo(200 / 255)
          const mask = new Float32Array(1024 * 1024)
          // 横图的有效内容位于 y=256..767，左半透明、右半实心。
          for (let y = 256; y < 768; y++) for (let x = 512; x < 1024; x++) mask[y * 1024 + x] = 1
          return { 'output-custom': { data: mask, dims: [1, 1, 1024, 1024] } }
        },
      }),
    },
  }
  const service = createMattingService({
    directory: dir,
    load: async () => {
      loads++
      return fake
    },
  })
  const rgba = new Uint8Array(8 * 4 * 4)
  for (let i = 0; i < 32; i++) rgba.set([200, 100, 50, 255], i * 4)
  for (let run = 0; run < 2; run++) {
    const output = await service.infer(rgba, 8, 4)
    expect(output[3]).toBe(0)
    expect(output[(3 * 8 + 7) * 4 + 3]).toBe(255)
  }
  expect(loads).toBe(1)
})

test('未安装模型回退算法且不下载，透明图在三种模式下保留，坏图片不抛出', async () => {
  let fetched = false
  const service = createMattingService({
    directory: await directory(),
    fetch: async () => {
      fetched = true
      throw new Error('No network')
    },
  })
  const opaque = await sharp({ create: { width: 20, height: 20, channels: 4, background: '#ffffff' } })
    .png()
    .toBuffer()
  const result = await service.cutout(opaque, options)
  const raw = await sharp(result).ensureAlpha().raw().toBuffer()
  expect(raw[3]).toBe(0)
  expect(fetched).toBe(false)
  const transparent = await sharp({
    create: { width: 20, height: 20, channels: 4, background: { r: 100, g: 80, b: 60, alpha: 0 } },
  })
    .png()
    .toBuffer()
  for (const mode of ['algorithm', 'native', 'model'] as const)
    expect(
      await sharp(await service.cutout(transparent, { ...options, mode }))
        .raw()
        .toBuffer(),
    ).toEqual(await sharp(transparent).raw().toBuffer())
  const bad = new Uint8Array([1, 2, 3])
  expect(await service.cutout(bad, options)).toEqual(bad)
})
