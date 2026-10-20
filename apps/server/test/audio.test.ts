import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AudioTrackDTO, ChatDTO, PlayPresetDTO } from '@nobot/shared'

// 环境、数据库和注册表都是单例，通过子进程保证全量测试互不污染。
test('AUD1：音频格式、CRUD、导入、Range 与上下文开关', async () => {
  if (!process.env.AUD1_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, AUD1_TEST_CHILD: '1' },
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
  const directory = await mkdtemp(join(tmpdir(), 'nobot-audio-'))
  process.env.DATA_DIR = directory
  await (await import('../src/bootstrap')).bootstrap()
  const { sqlite } = await import('../src/db/client')
  const { app } = await import('../src/app')
  const { detectAudioMime, saveAudioTrack, importAudioUrl } = await import('../src/services/audio-library')
  const { updateExtension } = await import('../src/extensions/registry')
  const { assemble, loadGenerationContext } = await import('../src/services/context')
  const headers = [
    [Buffer.from('ID3'), 'audio/mpeg'],
    [Buffer.from([0xff, 0xfb]), 'audio/mpeg'],
    [Buffer.from('OggS'), 'audio/ogg'],
    [Buffer.from('RIFF0000WAVE'), 'audio/wav'],
    [Buffer.from('0000ftyp'), 'audio/mp4'],
    [Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), 'audio/webm'],
    [Buffer.from('fLaC'), 'audio/flac'],
  ] as const
  const req = (path: string, method = 'GET', body?: unknown) =>
    app.request(`/api${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
  const json = async <T>(path: string, method = 'GET', body?: unknown) => {
    const response = await req(path, method, body)
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json() as Promise<T>
  }
  let fetchMock: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined
  try {
    for (const [bytes, mime] of headers) expect(detectAudioMime(bytes)).toBe(mime)
    expect(() => detectAudioMime(Buffer.from('unknown'))).toThrow('无法识别的音频文件')
    await expect(
      saveAudioTrack(new Uint8Array(30 * 1024 * 1024 + 1), { name: 'large', kind: 'bgm' }),
    ).rejects.toMatchObject({ status: 413 })
    updateExtension('audio', { enabled: true })
    const form = new FormData()
    form.set('file', new File([Buffer.from('ID3music')], 'Night.mp3'))
    form.set('description', '仅给用户看的描述')
    form.set('durationMs', '1500')
    const response = await app.request('/api/ext/audio/tracks', { method: 'POST', body: form })
    expect(response.status).toBe(200)
    const track = (await response.json()) as AudioTrackDTO
    expect(track).toMatchObject({ name: 'Night', kind: 'bgm', mime: 'audio/mpeg', size: 8, durationMs: 1500 })
    const file = join(directory, 'users/test/assets/audio', `${track.id}.mp3`)
    expect(await Bun.file(file).exists()).toBe(true)
    expect(await json('/ext/audio/tracks?kind=bgm')).toEqual([track])
    expect(await json('/ext/audio/tracks?kind=sfx')).toEqual([])
    expect((await req('/ext/audio/tracks?kind=wrong')).status).toBe(400)
    const range = await app.request(track.url, { headers: { Range: 'bytes=1-3' } })
    expect(range.status).toBe(206)
    expect(range.headers.get('Content-Type')).toBe('audio/mpeg')
    expect(range.headers.get('Content-Range')).toBe('bytes 1-3/8')
    expect(await range.text()).toBe('D3m')
    expect((await app.request(track.url, { headers: { Range: 'bytes=99-' } })).status).toBe(416)
    expect(await json(`/ext/audio/tracks/${track.id}`, 'PATCH', { name: 'Evening' })).toMatchObject({ name: 'Evening' })
    expect((await req(`/ext/audio/tracks/${track.id}`, 'PATCH', { name: '' })).status).toBe(400)
    fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(async () => new Response('OggSsound'), { preconnect: fetch.preconnect }),
    )
    const effect = await json<AudioTrackDTO>('/ext/audio/tracks/import-url', 'POST', {
      url: 'https://8.8.8.8/Bell.ogg',
      kind: 'sfx',
    })
    expect(effect).toMatchObject({ name: 'Bell', kind: 'sfx', mime: 'audio/ogg', durationMs: null })
    await expect(importAudioUrl({ url: 'http://127.0.0.1/file' })).rejects.toMatchObject({ status: 400 })
    await expect(importAudioUrl({ url: 'http://[::1]/file' })).rejects.toMatchObject({ status: 400 })
    await expect(importAudioUrl({ url: 'file:///file' })).rejects.toMatchObject({ status: 400 })
    fetchMock.mockImplementation(
      Object.assign(async () => new Response(null, { status: 302, headers: { location: 'http://192.168.1.1/file' } }), {
        preconnect: fetch.preconnect,
      }),
    )
    await expect(importAudioUrl({ url: 'https://8.8.8.8/redirect' })).rejects.toMatchObject({ status: 400 })
    fetchMock.mockImplementation(Object.assign(async () => new Response('not audio'), { preconnect: fetch.preconnect }))
    expect((await req('/ext/audio/tracks/import-url', 'POST', { url: 'https://8.8.8.8/bad' })).status).toBe(400)
    fetchMock.mockRestore()
    fetchMock = undefined
    const actor = await json<{ id: string }>('/characters', 'POST', { name: 'Actor' })
    const chat = await json<ChatDTO>('/chats', 'POST', { characterId: actor.id })
    const preset = await json<PlayPresetDTO>('/play-presets', 'POST', {
      name: 'Audio test',
      data: {
        directives: {
          enabled: true,
          kinds: ['audio'],
          lists: ['audio'],
          template: '{{vn_kinds}}\nAvailable music: {{vn_bgm}}\nAvailable sound effects: {{vn_sfx}}\n{{vn_example}}',
        },
      },
    })
    await json(`/chats/${chat.id}`, 'PATCH', { playPresetId: preset.id })
    const content = () => {
      const ctx = loadGenerationContext(chat.id, { requireConnection: false })
      return JSON.stringify(assemble(ctx, { type: 'normal', speakerId: actor.id, leafId: chat.activeLeafId }).messages)
    }
    let prompt = content()
    expect(prompt).toContain('Available music: Evening')
    expect(prompt).toContain('Available sound effects: Bell')
    expect(prompt).toContain('Change background music')
    expect(prompt).not.toContain('仅给用户看的描述')
    updateExtension('audio', { settings: { listInPrompt: false } })
    prompt = content()
    expect(prompt).not.toContain('Available music:')
    expect(prompt).toContain('Change background music')
    updateExtension('audio', { enabled: false })
    prompt = content()
    expect(prompt).not.toContain('Change background music')
    expect(prompt).not.toContain('Skip audio tags')
    expect(prompt).not.toContain('Available music:')
    updateExtension('audio', { enabled: true })
    await json(`/ext/audio/tracks/${track.id}`, 'DELETE')
    expect(await Bun.file(file).exists()).toBe(false)
    const extra = await saveAudioTrack(Buffer.from('fLaC'), { name: 'Extra', kind: 'bgm' })
    expect((await req('/ext/audio/tracks/batch-delete', 'POST', { ids: [effect.id, 'missing'] })).status).toBe(404)
    expect(await Bun.file(join(directory, 'users/test/assets/audio', `${effect.id}.ogg`)).exists()).toBe(true)
    await json('/ext/audio/tracks/batch-delete', 'POST', { ids: [effect.id, extra.id, extra.id] })
    expect(await json('/ext/audio/tracks')).toEqual([])
    expect(await Bun.file(join(directory, 'users/test/assets/audio', `${effect.id}.ogg`)).exists()).toBe(false)
    expect(await Bun.file(join(directory, 'users/test/assets/audio', `${extra.id}.flac`)).exists()).toBe(false)
  } finally {
    fetchMock?.mockRestore()
    sqlite.close()
    await rm(directory, { recursive: true, force: true })
  }
})
