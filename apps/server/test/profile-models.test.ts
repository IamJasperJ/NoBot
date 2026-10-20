import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('模型列表接口使用当前用户连接，图片草稿覆盖扩展和默认配置组', async () => {
  if (!process.env.PROFILE_MODELS_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, PROFILE_MODELS_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, out + err).toBe(0)
    return
  }
  delete (globalThis as typeof globalThis & { __NOBOT_TEST_USER__?: string }).__NOBOT_TEST_USER__
  const directory = await mkdtemp(join(tmpdir(), 'profile-models-'))
  process.env.DATA_DIR = directory
  process.env.NOBOT_ADMIN_PASSWORD = 'password-admin'
  process.env.NOBOT_ADMIN_USERNAME = 'admin'
  await (await import('../src/bootstrap')).bootstrap()
  const server = (await import('../src/server')).createServer()
  const { closeUserDatabase } = await import('../src/user-context')
  const req = (path: string, method = 'GET', body?: unknown, cookie = '') =>
    server.request(`http://local/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const json = async <T>(path: string, method: string, body: unknown, cookie: string): Promise<T> => {
    const response = await req(path, method, body, cookie)
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json() as Promise<T>
  }
  const login = async (handle: string, password: string) => {
    const response = await req('/auth/login', 'POST', { handle, password })
    expect(response.status).toBe(200)
    return response.headers.get('Set-Cookie')!.split(';')[0]!
  }
  const calls: { url: string; headers: Headers }[] = []
  let failure = false
  const mocked = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls.push({ url: String(input), headers: new Headers(init?.headers) })
        if (failure) return Response.json({ error: { message: 'unavailable' } }, { status: 500 })
        if (String(input).endsWith('/object_info'))
          return Response.json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['checkpoint']] } } } })
        return Response.json({ data: [{ id: 'image-model', architecture: { output_modalities: ['image'] } }] })
      },
      { preconnect: fetch.preconnect },
    ),
  )
  try {
    const admin = await login('admin', 'password-admin')
    await json('/admin/users', 'POST', { handle: 'bob', name: 'Bob', password: 'password-bob' }, admin)
    const bob = await login('bob', 'password-bob')
    const saved = await json<{ id: string }>(
      '/connections',
      'POST',
      {
        name: '连接',
        baseUrl: 'http://saved/v1',
        apiKey: 'saved-secret',
        model: 'chat',
        headers: { 'X-Saved': 'yes' },
      },
      admin,
    )
    expect((await req(`/connections/${saved.id}/models`)).status).toBe(401)
    expect((await req(`/connections/${saved.id}/models`, 'GET', undefined, bob)).status).toBe(404)
    expect(await json(`/connections/${saved.id}/models`, 'GET', undefined, admin)).toEqual({ models: ['image-model'] })
    expect(calls.at(-1)?.headers.get('authorization')).toBe('Bearer saved-secret')
    expect(calls.at(-1)?.headers.get('x-saved')).toBe('yes')
    failure = true
    const failed = await req(`/connections/${saved.id}/models`, 'GET', undefined, admin)
    expect(failed.status).toBe(400)
    expect(await failed.json()).toMatchObject({
      error: { code: 'MODELS_FAILED', message: expect.stringContaining('拉取模型列表失败') },
    })
    failure = false
    const profile = await json<{ id: string }>(
      '/profiles',
      'POST',
      { name: '默认组', image: { source: 'comfy', url: 'http://global-comfy' } },
      admin,
    )
    await json('/profiles/default', 'PUT', { id: profile.id }, admin)
    await json(
      '/extensions/image-gen',
      'PATCH',
      {
        settings: {
          openaiBaseUrl: 'http://extension/v1',
          openaiConnectionId: '',
          comfyWorkflows: [{ name: 'custom', json: '{}' }],
        },
      },
      admin,
    )
    for (const source of ['openai', 'openrouter'] as const) {
      const result = await json<{ options: { value: string }[] }>(
        `/ext/image-gen/${source}/models`,
        'POST',
        { profileImage: { source, connectionId: saved.id } },
        admin,
      )
      expect(result.options[0]?.value).toBe('image-model')
      expect(calls.at(-1)?.url).toBe('http://saved/v1/models')
      expect(calls.at(-1)?.headers.get('authorization')).toBe('Bearer saved-secret')
    }
    await json(
      '/ext/image-gen/comfy/models',
      'POST',
      { profileImage: { source: 'comfy', url: 'http://draft-comfy' } },
      admin,
    )
    expect(calls.at(-1)?.url).toBe('http://draft-comfy/object_info')
    await json('/ext/image-gen/openai/models', 'POST', { profileImage: null }, admin)
    expect(calls.at(-1)?.url).toBe('http://extension/v1/models')
    await json('/extensions/image-gen', 'PATCH', { enabled: false }, admin)
    const workflows = await json<{ options: { value: string }[] }>('/ext/image-gen/comfy/workflows', 'POST', {}, admin)
    expect(workflows.options.map((item) => item.value)).toEqual(['', 'avatar', 'custom'])
    expect(
      (await json<{ options: unknown[] }>('/ext/image-gen/styles', 'POST', {}, admin)).options.length,
    ).toBeGreaterThan(0)
    expect(
      (await req('/profiles', 'POST', { name: '越权连接', image: { source: 'openai', connectionId: saved.id } }, bob))
        .status,
    ).toBe(404)
  } finally {
    mocked.mockRestore()
    closeUserDatabase('admin')
    closeUserDatabase('bob')
    await rm(directory, { recursive: true, force: true })
  }
})
