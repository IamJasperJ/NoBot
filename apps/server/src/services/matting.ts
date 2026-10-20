import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { MattingPart, MattingStatus } from '@nobot/shared'
import sharp from 'sharp'
import {
  applyAlphaMask,
  hasTransparentBackground,
  removeSpriteBackground,
} from '../../../../packages/core/src/stage/image'
import { env } from '../env'
import type { Settings } from '../extensions/builtin/image-gen/settings'
import { t } from '../i18n'

export type MattingMode = 'algorithm' | 'native' | 'model'
export interface MattingOptions {
  mode: MattingMode
  backdrop: 'green' | 'white'
  modelUrl: string
  registry: string
}
export function mattingOptions(settings: Settings): MattingOptions {
  return {
    mode: settings.spriteMatting,
    backdrop: settings.spriteBackdrop,
    modelUrl: settings.mattingModelUrl,
    registry: settings.mattingRegistry,
  }
}

interface Tensor {
  data: Float32Array
  dims: readonly number[]
}
export interface MattingSession {
  inputNames: readonly string[]
  outputNames: readonly string[]
  run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>
  release?(): Promise<void>
}
export interface MattingRuntime {
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => Tensor
  InferenceSession: { create(path: string): Promise<MattingSession> }
}
export interface MattingDependencies {
  directory: string
  fetch: (url: string) => Promise<Response>
  spawn: (args: string[], cwd: string) => Promise<void>
  load: (entry: string) => Promise<MattingRuntime>
}

const exists = async (file: string) => (await stat(file).catch(() => null))?.size ?? 0

/** 每个数据目录独立持有安装锁和推理会话，测试可替换网络、进程和动态模块。 */
export function createMattingService(overrides: Partial<MattingDependencies> = {}) {
  const deps: MattingDependencies = {
    directory: join(env.dataDir, 'models', 'matting'),
    fetch: (url) => fetch(url),
    spawn: async (args, cwd) => {
      const child = Bun.spawn([process.execPath, ...args], { cwd, stdout: 'ignore', stderr: 'pipe' })
      const error = await new Response(child.stderr).text()
      if ((await child.exited) !== 0) throw new Error(error.slice(-2000))
    },
    load: async (entry) => import(pathToFileURL(entry).href),
    ...overrides,
  }
  const runtimeDir = join(deps.directory, 'runtime')
  const modelFile = join(deps.directory, 'isnetis.onnx')
  let runtime: MattingPart = { state: 'missing' }
  let model: MattingPart = { state: 'missing' }
  let pending: Promise<void> | undefined
  let starting: Promise<void> | undefined
  let session: Promise<{ runtime: MattingRuntime; session: MattingSession }> | undefined
  let deleting = false
  let active = 0
  let idle: (() => void) | undefined
  async function entry() {
    try {
      const pkg = JSON.parse(
        await readFile(join(runtimeDir, 'node_modules/onnxruntime-node/package.json'), 'utf8'),
      ) as { main?: string }
      const file = join(runtimeDir, 'node_modules/onnxruntime-node', pkg.main ?? 'dist/index.js')
      return (await exists(file)) ? file : null
    } catch {
      return null
    }
  }
  async function status(): Promise<MattingStatus> {
    if (runtime.state !== 'installing' && runtime.state !== 'error') {
      const previous = runtime
      const ready = await entry()
      // 磁盘读取期间可能开始安装，不用旧检查结果覆盖新状态。
      if (runtime === previous) runtime = { state: ready ? 'ready' : 'missing' }
    }
    if (model.state !== 'installing' && model.state !== 'error') {
      const previous = model
      const ready = await exists(modelFile)
      if (model === previous) model = { state: ready ? 'ready' : 'missing' }
    }
    return structuredClone({ runtime, model })
  }
  async function installRuntime(registry: string) {
    try {
      await mkdir(runtimeDir, { recursive: true })
      await writeFile(join(runtimeDir, 'package.json'), '{"private":true}')
      await deps.spawn(['add', 'onnxruntime-node@1.30.0', ...(registry ? ['--registry', registry] : [])], runtimeDir)
      // 包的 bin/napi-v*/平台/架构 分层存放原生库，只清理其他平台和架构。
      const bin = join(runtimeDir, 'node_modules/onnxruntime-node/bin')
      for (const version of await readdir(bin)) {
        if (!version.startsWith('napi-v')) continue
        for (const platform of await readdir(join(bin, version))) {
          const platformDir = join(bin, version, platform)
          if (platform !== process.platform) await rm(platformDir, { recursive: true, force: true })
          else
            for (const arch of await readdir(platformDir))
              if (arch !== process.arch) await rm(join(platformDir, arch), { recursive: true, force: true })
        }
      }
      if (!(await entry())) throw new Error(t('抠图运行时安装不完整'))
      runtime = { state: 'ready' }
    } catch (error) {
      runtime = { state: 'error', error: t('抠图运行时安装失败：{error}', { error: String(error) }) }
    }
  }
  async function installModel(url: string) {
    const partial = `${modelFile}.part`
    try {
      await mkdir(deps.directory, { recursive: true })
      const response = await deps.fetch(url)
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const length = Number(response.headers.get('content-length'))
      model = { state: 'installing', received: 0, ...(length > 0 ? { total: length } : {}) }
      const writer = Bun.file(partial).writer()
      try {
        for await (const chunk of response.body) {
          writer.write(chunk)
          model.received = (model.received ?? 0) + chunk.length
        }
      } finally {
        await writer.end()
      }
      if (!model.received || (model.total && model.received !== model.total)) throw new Error(t('抠图模型下载不完整'))
      await rename(partial, modelFile)
      model = { state: 'ready' }
    } catch (error) {
      await rm(partial, { force: true })
      model = { state: 'error', error: t('抠图模型下载失败：{error}', { error: String(error) }) }
    }
  }
  async function install(options: MattingOptions): Promise<MattingStatus> {
    if (pending || deleting) {
      await starting
      return status()
    }
    let started!: () => void
    starting = new Promise<void>((resolve) => {
      started = resolve
    })
    // 同步占锁后才检查磁盘，避免重复请求越过第一个 await。
    pending = (async () => {
      const current = await status()
      const tasks: Promise<void>[] = []
      if (current.runtime.state !== 'ready') {
        runtime = { state: 'installing' }
        tasks.push(installRuntime(options.registry))
      }
      if (current.model.state !== 'ready') {
        model = { state: 'installing', received: 0 }
        tasks.push(installModel(options.modelUrl))
      }
      started()
      await Promise.all(tasks)
    })().finally(() => {
      started()
      pending = undefined
      starting = undefined
    })
    // 只等待磁盘检查及状态切换，下载和安装继续在后台运行。
    await starting
    return status()
  }
  async function remove(): Promise<MattingStatus> {
    if (pending || deleting) throw new Error(t('抠图组件正在安装，无法删除'))
    deleting = true
    try {
      if (active)
        await new Promise<void>((resolve) => {
          idle = resolve
        })
      if (session) await (await session.catch(() => null))?.session.release?.()
      session = undefined
      await rm(deps.directory, { recursive: true, force: true })
      runtime = { state: 'missing' }
      model = { state: 'missing' }
      return status()
    } finally {
      deleting = false
    }
  }
  async function infer(rgba: Uint8Array, w: number, h: number): Promise<Uint8Array> {
    if (deleting) throw new Error(t('抠图模型未安装'))
    active++
    try {
      const current = await status()
      if (current.runtime.state !== 'ready' || current.model.state !== 'ready') throw new Error(t('抠图模型未安装'))
      session ??= (async () => {
        const rt = await deps.load((await entry())!)
        return { runtime: rt, session: await rt.InferenceSession.create(modelFile) }
      })().catch((error) => {
        session = undefined
        throw error
      })
      const loaded = await session
      const scale = 1024 / Math.max(w, h)
      const sw = Math.max(1, Math.round(w * scale)),
        sh = Math.max(1, Math.round(h * scale))
      const left = Math.floor((1024 - sw) / 2),
        top = Math.floor((1024 - sh) / 2)
      const rgb = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
        .removeAlpha()
        .resize(sw, sh)
        .extend({ left, top, right: 1024 - sw - left, bottom: 1024 - sh - top, background: '#000000' })
        .raw()
        .toBuffer()
      const plane = 1024 * 1024
      const data = new Float32Array(plane * 3)
      for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) data[c * plane + i] = rgb[i * 3 + c]! / 255
      const outputs = await loaded.session.run({
        [loaded.session.inputNames[0]!]: new loaded.runtime.Tensor('float32', data, [1, 3, 1024, 1024]),
      })
      const output = outputs[loaded.session.outputNames[0]!]!
      if (output.data.length !== plane) throw new RangeError('Invalid model mask dimensions')
      // 先裁掉 letterbox，再在浮点精度下回贴，保留柔和的抗锯齿边缘。
      const crop = new Float32Array(sw * sh)
      for (let y = 0; y < sh; y++)
        crop.set(output.data.subarray((y + top) * 1024 + left, (y + top) * 1024 + left + sw), y * sw)
      const mask = new Float32Array(w * h)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const sx = Math.max(0, Math.min(sw - 1, ((x + 0.5) * sw) / w - 0.5))
          const sy = Math.max(0, Math.min(sh - 1, ((y + 0.5) * sh) / h - 0.5))
          const x0 = Math.floor(sx),
            y0 = Math.floor(sy),
            x1 = Math.min(sw - 1, x0 + 1),
            y1 = Math.min(sh - 1, y0 + 1)
          const dx = sx - x0,
            dy = sy - y0
          mask[y * w + x] =
            (crop[y0 * sw + x0]! * (1 - dx) + crop[y0 * sw + x1]! * dx) * (1 - dy) +
            (crop[y1 * sw + x0]! * (1 - dx) + crop[y1 * sw + x1]! * dx) * dy
        }
      return applyAlphaMask(rgba, w, h, mask)
    } finally {
      active--
      if (!active) {
        idle?.()
        idle = undefined
      }
    }
  }
  async function cutout(bytes: Uint8Array, options: MattingOptions): Promise<Uint8Array> {
    try {
      const { data, info } = await sharp(bytes).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      let rgba: Uint8Array = data
      if (!hasTransparentBackground(data, info.width, info.height)) {
        if (options.mode === 'model') {
          try {
            rgba = await infer(data, info.width, info.height)
          } catch (error) {
            console.warn('[matting] Model fallback', error)
            rgba = removeSpriteBackground(data, info.width, info.height)
          }
        } else {
          if (options.mode === 'native') console.warn('[matting] Native image is opaque; using algorithm')
          rgba = removeSpriteBackground(data, info.width, info.height)
        }
      }
      return await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
        .png()
        .toBuffer()
    } catch (error) {
      // 无法解码时也不能让立绘生成任务丢图；原始字节交给现有保存流程校验。
      console.warn('[matting] Image processing failed', error)
      return bytes
    }
  }
  return { status, install, remove, infer, cutout, waitForInstall: () => pending }
}
export const mattingService = createMattingService()
/** 把立绘转成透明 PNG；模型不可用时仅回退算法，不触发下载。 */
export const cutoutSprite = mattingService.cutout
