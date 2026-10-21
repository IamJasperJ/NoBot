import { expect, spyOn, test } from 'bun:test'
import {
  audioApi,
  audioTracksKey,
  readAudioDuration,
  useAudioTracks,
  useDeleteAudioTracks,
  useImportAudioUrl,
  useUpdateAudioTrack,
  useUploadAudioTrack,
} from './audio'
import { setupHooks } from './hooks.test-utils'

test('音频客户端与 hooks：元数据、表单、路由、错误和清单失效', async () => {
  // 全量测试中的 Bun 原生异步清理也会调用 URL 静态方法；独立进程隔离这些全局 mock。
  if (!process.env.AUDIO_CLIENT_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, AUDIO_CLIENT_TEST_CHILD: '1' },
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
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  let mode: 'success' | 'error' | 'timeout' = 'success'
  let released = 0
  let loaded = 0
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => ({
        duration: 1.25,
        onloadedmetadata: null as (() => void) | null,
        onerror: null as (() => void) | null,
        removeAttribute() {
          released++
        },
        load() {
          loaded++
        },
        set src(_url: string) {
          queueMicrotask(() => {
            if (mode === 'success') this.onloadedmetadata?.()
            else if (mode === 'error') this.onerror?.()
          })
        },
      }),
    },
  })
  const objectUrl = spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
  const revoke = spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const requests: { path: string; init?: RequestInit }[] = []
  let fail = false
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests.push({ path: String(input), init })
        return fail
          ? Response.json({ error: { code: 'BAD_AUDIO', message: '无法识别的音频文件' } }, { status: 400 })
          : Response.json({ id: 'track' })
      },
      { preconnect: fetch.preconnect },
    ),
  )
  const { qc, render } = setupHooks()
  const invalidate = spyOn(qc, 'invalidateQueries')
  const file = new File(['ID3'], 'Night.mp3')
  try {
    const upload = render(useUploadAudioTrack)
    await upload.mutateAsync({ file, kind: 'bgm', name: 'Night', description: 'calm' })
    expect(requests.at(-1)?.path).toBe('/api/ext/audio/tracks')
    const form = requests.at(-1)?.init?.body as FormData
    expect(form.get('durationMs')).toBe('1250')
    expect(form.get('description')).toBe('calm')
    expect(form.get('file')).toBeInstanceOf(File)
    // 上传表单不能手动设 Content-Type（要由浏览器带上 boundary）
    expect(new Headers(requests.at(-1)?.init?.headers).has('Content-Type')).toBe(false)
    mode = 'error'
    await audioApi.upload({ file })
    const withoutDuration = requests.at(-1)!.init!.body as FormData
    expect(withoutDuration.has('durationMs')).toBe(false)
    mode = 'timeout'
    expect(await readAudioDuration(file)).toBeUndefined()
    expect(released).toBe(3)
    expect(loaded).toBe(3)
    expect(revoke).toHaveBeenCalledTimes(3)
    await render(useImportAudioUrl).mutateAsync({ url: 'https://example.com/a.mp3', kind: 'sfx' })
    expect(requests.at(-1)?.path).toBe('/api/ext/audio/tracks/import-url')
    await render(useUpdateAudioTrack).mutateAsync({ id: 'a/b', input: { name: 'New' } })
    expect(requests.at(-1)?.path).toBe('/api/ext/audio/tracks/a%2Fb')
    expect(requests.at(-1)?.init?.body).toBe('{"name":"New"}')
    await render(useDeleteAudioTracks).mutateAsync(['track'])
    expect(requests.at(-1)?.path).toBe('/api/ext/audio/tracks/batch-delete')
    expect(
      invalidate.mock.calls.filter(([input]) => JSON.stringify(input?.queryKey) === '["audioTracks"]').length,
    ).toBe(4)
    await audioApi.remove('track')
    expect(requests.at(-1)?.init?.method).toBe('DELETE')
    await audioApi.list('sfx')
    expect(requests.at(-1)?.path).toBe('/api/ext/audio/tracks?kind=sfx')
    expect(audioTracksKey()).toEqual(['audioTracks'])
    expect(audioTracksKey('bgm')).toEqual(['audioTracks', 'bgm'])
    qc.setQueryData(audioTracksKey('bgm'), [{ id: 'bgm' }])
    qc.setQueryData(audioTracksKey('sfx'), [{ id: 'sfx' }])
    expect(render(() => useAudioTracks('bgm')).data?.[0]?.id).toBe('bgm')
    expect(render(() => useAudioTracks('sfx')).data?.[0]?.id).toBe('sfx')
    fail = true
    await expect(audioApi.list()).rejects.toMatchObject({ code: 'BAD_AUDIO' })
  } finally {
    fetchMock.mockRestore()
    objectUrl.mockRestore()
    revoke.mockRestore()
    invalidate.mockRestore()
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
    else Reflect.deleteProperty(globalThis, 'document')
    qc.clear()
  }
})
