import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离数据库单例和全局 fetch，不监听任何端口。
test('IMG6–8：适配器注册、请求响应、能力发现与错误', async () => {
  if (!process.env.IMG_BACKENDS_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, IMG_BACKENDS_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    return
  }
  const directory = await mkdtemp(join(tmpdir(), 'image-backends-'))
  process.env.DATA_DIR = directory
  const { bootstrap } = await import('../../../../bootstrap')
  await bootstrap()
  const { sqlite } = await import('../../../../db/client')
  const { getBackend, imageBackends, backendDimensions } = await import('./index')
  const { parseSettings } = await import('../settings')
  const { a1111Body } = await import('./a1111')
  const { object } = await import('./http')
  const { resolveImageConnection } = await import('../discovery')
  const { createApiPreset } = await import('../../../../services/connections')
  const calls: Request[] = []
  const png = Buffer.from([137, 80, 78, 71])
  let missingScheduler = false
  let scripts = true
  let version = false
  let empty = false
  let badAuth = false
  let failPrompt = false
  const mock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(String(input), init)
        calls.push(request)
        const path = new URL(request.url).pathname
        if (badAuth) return new Response('Unauthorized', { status: 401 })
        if (path.endsWith('/models'))
          return Response.json({
            data: [
              { id: 'text', architecture: { output_modalities: ['text'] } },
              { id: 'image', name: 'Image model', architecture: { output_modalities: ['text', 'image'] } },
              { id: 'unknown' },
            ],
          })
        if (path.endsWith('/images/generations'))
          return Response.json({ data: empty ? [] : [{ b64_json: png.toString('base64') }] })
        if (path.endsWith('/chat/completions'))
          return Response.json({
            choices: [
              {
                message: {
                  images: empty ? [] : [{ image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }],
                },
              },
            ],
          })
        if (path === '/object_info')
          return Response.json({
            CheckpointLoaderSimple: { input: { required: { ckpt_name: [['checkpoint']] } } },
            KSampler: { input: { required: { sampler_name: [['euler']], scheduler: [['normal']] } } },
            VAELoader: { input: { required: { vae_name: [['vae']] } } },
          })
        if (path === '/prompt') return Response.json(failPrompt ? {} : { prompt_id: 'job' })
        if (path === '/history/job')
          return Response.json({ job: { outputs: { '1': { images: [{ filename: 'test.png' }] } } } })
        if (path === '/view') return new Response(png)
        if (path === '/system_stats') return Response.json({})
        if (path === '/sdapi/v1/sd-models') return Response.json([{ title: 'checkpoint [hash]' }])
        if (path === '/sdapi/v1/samplers') return Response.json([{ name: 'Euler a' }])
        if (path === '/sdapi/v1/schedulers')
          return missingScheduler ? new Response('', { status: 404 }) : Response.json([{ name: 'Karras' }])
        if (path === '/sdapi/v1/sd-vae') return Response.json([{ model_name: 'vae.safetensors' }])
        if (path === '/sdapi/v1/upscalers') return Response.json([{ name: 'Latent' }])
        if (path === '/sdapi/v1/scripts') return Response.json({ txt2img: scripts ? ['ADetailer'] : [] })
        if (path === '/adetailer/v1/version')
          return version ? Response.json({ version: '24.1' }) : new Response('', { status: 404 })
        if (path === '/sdapi/v1/options') return Response.json({})
        if (path === '/sdapi/v1/txt2img')
          return Response.json({ images: empty ? [] : [png.toString('base64')], info: '{"seed":42}' })
        return new Response('', { status: 404 })
      },
      { preconnect: fetch.preconnect },
    ),
  )
  try {
    expect(Object.keys(imageBackends).sort()).toEqual(['a1111', 'comfy', 'openai', 'openrouter'])
    for (const source of Object.keys(imageBackends) as (keyof typeof imageBackends)[]) {
      const settings = parseSettings({ source, openrouterModel: 'image' })
      const backend = getBackend(settings)
      expect(backend.id).toBe(source)
      expect(backend.settingsSchema.length).toBeGreaterThan(0)
      expect(backend.settingsSchema.every((field) => field.visibleWhen !== undefined)).toBe(true)
      backend.validate(settings)
      await backend.test(settings)
      const discovered = await backend.discover(settings)
      expect(discovered.models.length).toBeGreaterThan(0)
      const result = await backend.generate({ settings, prompt: 'cat', width: 640, height: 960 })
      expect(result.bytes).toEqual(new Uint8Array(png))
      expect(result.mime).toBe('image/png')
      if (source === 'a1111') expect(result.seed).toBe(42)
    }
    const openai = parseSettings({ openaiSnapSize: true })
    expect(backendDimensions(openai, 640, 960)).toEqual({ width: 1024, height: 1536 })
    expect(getBackend(openai).capabilitiesFor?.(openai).sizes).toEqual(
      expect.arrayContaining([
        { width: 1024, height: 1024 },
        { width: 1536, height: 1024 },
        { width: 1024, height: 1536 },
      ]),
    )
    const comfyBody = await calls.find((request) => new URL(request.url).pathname === '/prompt')!.json()
    expect(JSON.stringify(object(comfyBody).prompt)).toContain('cat')
    expect(object(comfyBody).client_id).toBeString()
    const openaiBody = await calls
      .find((request) => new URL(request.url).pathname.endsWith('/images/generations'))!
      .json()
    expect(openaiBody).toMatchObject({ model: 'gpt-image-1', prompt: 'cat', size: '640x960' })
    const router = parseSettings({ source: 'openrouter', openrouterModel: 'image' })
    expect((await getBackend(router).discover(router)).models).toEqual([{ value: 'image', label: 'Image model' }])
    const routerBody = await calls
      .find((request) => new URL(request.url).pathname.endsWith('/chat/completions'))!
      .json()
    expect(routerBody).toMatchObject({
      model: 'image',
      modalities: ['image', 'text'],
      messages: [{ role: 'user', content: 'cat' }],
      image_config: { aspect_ratio: '2:3' },
    })
    const connection = createApiPreset({
      name: 'Router',
      baseUrl: 'https://router.test/v1',
      model: 'chat',
      apiKey: 'saved-key',
      headers: { 'X-Saved': 'yes' },
    })
    const resolved = resolveImageConnection({
      ...router,
      openrouterConnectionId: connection.id,
      openrouterHeaders: '{"X-Saved":"override"}',
    })
    expect(resolved).toMatchObject({
      openrouterBaseUrl: 'https://router.test/v1',
      openrouterApiKey: 'saved-key',
      openrouterModel: 'image',
    })
    await getBackend(router).discover(resolved)
    expect(calls.at(-1)!.headers.get('authorization')).toBe('Bearer saved-key')
    expect(calls.at(-1)!.headers.get('x-saved')).toBe('override')
    const a1111 = parseSettings({
      source: 'a1111',
      a1111Auth: 'user:password',
      a1111Model: 'chosen',
      a1111Vae: 'vae',
      a1111Scheduler: 'Karras',
      a1111Hires: true,
      a1111Upscaler: 'Latent',
      a1111HiresScale: 2.5,
      a1111HiresSteps: 12,
      a1111Denoise: 0.4,
      a1111ADetailer: true,
      a1111RestoreFaces: true,
      seed: 123,
      negativePrompt: 'bad',
    })
    const body = a1111Body(a1111, 'cat', 512, 768)
    expect(body).toMatchObject({
      prompt: 'cat',
      negative_prompt: 'bad',
      width: 512,
      height: 768,
      seed: 123,
      scheduler: 'Karras',
      enable_hr: true,
      hr_upscaler: 'Latent',
      hr_scale: 2.5,
      hr_second_pass_steps: 12,
      denoising_strength: 0.4,
      restore_faces: true,
      override_settings: { sd_model_checkpoint: 'chosen', sd_vae: 'vae', CLIP_stop_at_last_layers: 1 },
      alwayson_scripts: { ADetailer: { args: [true, true, { ad_model: 'face_yolov8n.pt' }] } },
    })
    expect(a1111Body(parseSettings({}), 'cat', 512, 768)).not.toHaveProperty('alwayson_scripts')
    expect(a1111Body(parseSettings({}), 'cat', 512, 768)).not.toHaveProperty('hr_scale')
    const backend = getBackend(a1111)
    expect(await backend.discover(a1111)).toMatchObject({
      adetailer: true,
      schedulers: [{ value: 'Karras', label: 'Karras' }],
      vaes: [{ value: 'vae.safetensors', label: 'vae.safetensors' }],
      upscalers: [{ value: 'Latent', label: 'Latent' }],
    })
    expect(calls.at(-1)!.headers.get('authorization')).toBe(`Basic ${Buffer.from('user:password').toString('base64')}`)
    await backend.generate({ settings: a1111, prompt: 'cat', width: 512, height: 768 })
    expect(await calls.at(-1)!.json()).toEqual(body)
    const { renderImage } = await import('../pipeline')
    const { createExtensionHost } = await import('../../../host')
    const { listLogs, getLog } = await import('../../../../services/logs')
    const host = createExtensionHost(() => {})
    const storage = { get: () => undefined, set: () => {}, delete: () => {} }
    for (const settings of [a1111, resolved]) {
      await renderImage({ settings, host, storage }, settings, 'cat', 512, 768)
      const log = getLog(listLogs({})[0]!.id)
      expect(log.model).toBe(getBackend(settings).model(settings))
      const serialized = JSON.stringify(log)
      expect(serialized).not.toContain('user:password')
      expect(serialized).not.toContain(Buffer.from('user:password').toString('base64'))
      expect(serialized).not.toContain('saved-key')
    }
    missingScheduler = true
    scripts = false
    expect(await backend.discover(a1111)).toMatchObject({ adetailer: false, schedulers: [] })
    version = true
    expect((await backend.discover(a1111)).adetailer).toBe(true)
    badAuth = true
    await expect(backend.discover(a1111)).rejects.toThrow('401')
    badAuth = false
    empty = true
    for (const source of ['openai', 'openrouter', 'a1111'] as const) {
      const settings = parseSettings({ source })
      await expect(
        getBackend(settings).generate({ settings, prompt: 'cat', width: 512, height: 768 }),
      ).rejects.toThrow()
    }
    failPrompt = true
    const settings = parseSettings({ source: 'comfy' })
    await expect(getBackend(settings).generate({ settings, prompt: 'cat', width: 512, height: 768 })).rejects.toThrow()
    const controller = new AbortController()
    controller.abort()
    // fetch mock 本身不处理取消，适配器仍须给每个请求传递已取消的 signal。
    await getBackend(router)
      .generate({ settings: router, prompt: 'cat', width: 512, height: 768 }, controller.signal)
      .catch(() => {})
    expect(calls.at(-1)!.signal.aborted).toBe(true)
  } finally {
    mock.mockRestore()
    sqlite.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
