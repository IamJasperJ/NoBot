import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { makeZip } from '../../../../test/helpers/zip'
import type { ExtensionContext } from '../../types'

test('AUD3：参考音频、聊天 BGM、锁定与在途保护、CharX 音频导入和语气缓存', async () => {
  if (!process.env.AUD3_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, AUD3_TEST_CHILD: '1', TTS_FETCH_MOCK: '1' },
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
  const directory = await mkdtemp(join(tmpdir(), 'nobot-aud3-'))
  process.env.DATA_DIR = directory
  await (await import('../../../bootstrap')).bootstrap()
  const { sqlite, getSetting, setSetting } = await import('../../../db/client')
  const { createCharacter, importCharacter } = await import('../../../services/characters')
  const { createChat, updateChat } = await import('../../../services/chats')
  const { createPlayPreset } = await import('../../../services/playPresets')
  const { createExtensionHost } = await import('../../host')
  const { saveAudioTrack, listAudioTracks, deleteAudioTrack } = await import('../../../services/audio/audio-library')
  const { createTtsEngines, ttsEngines, mockAudio } = await import('./tts/engines')
  const { synthesizeVoice, clearTtsCache } = await import('./tts/service')
  const { audioSettings } = await import('./tts/settings')
  const { autoChatBgm, onBgmEvent, readChatBgm, registerChatBgmRoutes } = await import('./chat-bgm')
  const { registerTtsRoutes } = await import('./tts/routes')
  const { default: audio } = await import('./index')
  const { z } = await import('zod')
  try {
    const character = createCharacter({ name: 'Alice' })
    const chat = createChat({ characterId: character.id })
    const bgm = await saveAudioTrack(mockAudio, { name: 'Night Forest', kind: 'bgm', description: 'Quiet forest' })
    const ref = await saveAudioTrack(mockAudio, { name: 'Reference', kind: 'ref' })
    expect(listAudioTracks('ref').map((v) => v.id)).toEqual([ref.id])
    let reply = 'Night Forest'
    let calls = 0
    let resolve: ((value: string) => void) | undefined
    const ctx: Omit<ExtensionContext, 'chatId'> = {
      settings: {
        autoBgm: true,
        autoBgmEvery: 2,
        autoBgmConnectionId: 'custom-connection',
        autoBgmModel: 'custom-model',
      },
      host: {
        ...createExtensionHost(() => {}),
        quietPrompt: async (opts) => {
          calls++
          expect(opts.instruction).toContain('Night Forest — Quiet forest')
          expect(opts.connectionId).toBe('custom-connection')
          expect(opts.model).toBe('custom-model')
          return reply === 'pending'
            ? new Promise<string>((done) => {
                resolve = done
              })
            : reply
        },
      },
      storage: {
        get: <T>(key: string) => getSetting<T>(`extdata:audio:${key}`),
        set: (key, value) => setSetting(`extdata:audio:${key}`, value),
        delete: (key) => sqlite.query('DELETE FROM settings WHERE key = ?').run(`extdata:audio:${key}`),
      },
    }
    const app = new Hono()
    app.onError((error, c) => c.json({ error: error.message }, 'status' in error && error.status === 400 ? 400 : 500))
    registerChatBgmRoutes(app, ctx)
    registerTtsRoutes(app, ctx)
    const request = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
      app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    // 使用实际扩展错误边界；根设置损坏及未来新增的严格字段都应返回可读的 400。
    const invalidCtx = { ...ctx }
    Reflect.set(invalidCtx, 'settings', null)
    const audioApp = new Hono()
    audio.routes?.(audioApp, invalidCtx)
    audioApp.get('/invalid-settings-path', () => {
      z.object({ cosyvoiceVoices: z.array(z.object({ mode: z.literal('sft') })) }).parse({ cosyvoiceVoices: [{}] })
      throw new Error('校验应失败')
    })
    const invalidSettings = await audioApp.request('/tts/engines')
    expect(invalidSettings.status).toBe(400)
    expect(await invalidSettings.json()).toEqual({
      error: { code: 'BAD_REQUEST', message: '音频设置有无效内容：settings' },
    })
    const invalidPath = await audioApp.request('/invalid-settings-path')
    expect(invalidPath.status).toBe(400)
    expect(await invalidPath.json()).toEqual({
      error: { code: 'BAD_REQUEST', message: '音频设置有无效内容：cosyvoiceVoices.0.mode' },
    })
    const voices = await request('/tts/voices', {
      engine: 'cosyvoice',
      settings: { cosyvoiceApi: 'gateway', cosyvoiceVoices: [{ id: 'broken', mode: '' }, null] },
    })
    expect(voices.status).toBe(200)
    expect(await (await request('/tts/ref-tracks', {})).json()).toEqual({
      options: [{ value: ref.id, label: ref.name }],
    })
    expect(await (await request(`/chat-bgm?chatId=${chat.id}`)).json()).toBeNull()
    expect((await request('/chat-bgm', { chatId: chat.id, trackId: ref.id }, 'PUT')).status).toBe(400)
    await request('/chat-bgm', { chatId: chat.id, trackId: bgm.id, locked: true }, 'PUT')
    expect(await autoChatBgm(ctx, chat.id)).toMatchObject({ source: 'manual', locked: true, track: { id: bgm.id } })
    expect(calls).toBe(0)
    await request(`/chat-bgm?chatId=${chat.id}`, undefined, 'DELETE')
    expect(await autoChatBgm(ctx, chat.id)).toMatchObject({ trackId: bgm.id, source: 'auto', locked: false })
    reply = 'none'
    expect(await autoChatBgm(ctx, chat.id)).toMatchObject({ trackId: null, track: null })
    reply = 'invalid-selection'
    await expect(autoChatBgm(ctx, chat.id)).rejects.toThrow()
    reply = 'pending'
    const pending = autoChatBgm(ctx, chat.id)
    await request('/chat-bgm', { chatId: chat.id, trackId: null, locked: true }, 'PUT')
    resolve?.('Night Forest')
    await pending
    expect(readChatBgm(ctx, chat.id)).toMatchObject({ source: 'manual', trackId: null, locked: true })
    await request(`/chat-bgm?chatId=${chat.id}`, undefined, 'DELETE')
    reply = 'Night Forest'
    const append = () =>
      ctx.host.appendMessage(chat.id, { role: 'assistant', content: 'A quiet night.', meta: { logId: 'generated' } })
    let before = calls
    append()
    onBgmEvent({ type: 'generation:complete', chatId: chat.id }, ctx)
    expect(calls).toBe(before)
    append()
    onBgmEvent({ type: 'generation:complete', chatId: chat.id }, ctx)
    await autoChatBgm(ctx, chat.id)
    expect(calls).toBe(before + 1)
    const preset = createPlayPreset({ name: 'Stage', data: { directives: { enabled: true } } })
    updateChat(chat.id, { playPresetId: preset.id })
    ctx.host.appendMessage(chat.id, {
      role: 'assistant',
      content: '',
      meta: { logId: 'generated', stage: { v: 1, ops: [{ op: 'scene', bgm: '' }], beats: [] } },
    })
    append()
    before = calls
    onBgmEvent({ type: 'generation:complete', chatId: chat.id }, ctx)
    expect(calls).toBe(before)
    // 参考音频从库文件上传；仅 zero_shot 发送 prompt_wav。
    const engines = createTtsEngines({
      mock: false,
      fetch: (async (url, init) => {
        expect(url).toBe('http://127.0.0.1:50000/inference_zero_shot')
        const form = init?.body as FormData
        expect(form.get('prompt_text')).toBe('Reference text')
        expect(form.get('prompt_wav')).toBeInstanceOf(File)
        expect(new Uint8Array(await (form.get('prompt_wav') as File).arrayBuffer())).toEqual(mockAudio)
        expect(form.has('instruct_text')).toBe(false)
        return new Response(new Uint8Array([1, 0]))
      }) as typeof fetch,
    })
    const settings = audioSettings.parse({
      cosyvoiceVoices: [
        { id: 'ref', name: 'Ref', mode: 'zero_shot', promptText: 'Reference text', refTrackId: ref.id },
      ],
    })
    expect((await engines.cosyvoice.synthesize({ text: 'Hello', voice: 'ref', speed: 1 }, settings)).bytes.length).toBe(
      46,
    )
    await deleteAudioTrack(ref.id)
    await expect(engines.cosyvoice.synthesize({ text: 'Hello', voice: 'ref', speed: 1 }, settings)).rejects.toThrow()
    // 相同语气共用缓存；不同语气必须重新合成。
    let synthesized = 0
    const original = ttsEngines.minimax.synthesize
    ttsEngines.minimax.synthesize = async (input) => {
      synthesized++
      expect(input.params?.emotion).toBeDefined()
      return { bytes: mockAudio, mime: 'audio/wav' }
    }
    try {
      await clearTtsCache()
      const voice = { engine: 'minimax' as const, voice: 'custom', speed: 1 }
      const a = await synthesizeVoice(voice, 'Hello', audioSettings.parse({}), 'joy')
      expect(await synthesizeVoice(voice, 'Hello', audioSettings.parse({}), 'amusement')).toEqual(a)
      expect(await synthesizeVoice(voice, 'Hello', audioSettings.parse({}), 'sadness')).not.toEqual(a)
      expect(synthesized).toBe(2)
    } finally {
      ttsEngines.minimax.synthesize = original
    }
    // 未启用音频扩展，也要把 CharX 内的音频当数据导入。
    const assets = [
      { type: 'audio', name: 'Night Forest', uri: 'embedded://assets/night.mp3', ext: 'mp3' },
      { type: 'audio', uri: 'embeded://assets/sfx/bell.wav', ext: 'wav' },
      { type: 'audio', name: 'Sunset', uri: 'embedded://assets/sunset.ogg', ext: 'ogg' },
    ]
    const card = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Audio Card', assets } }
    const zip = makeZip([
      { path: 'card.json', data: Buffer.from(JSON.stringify(card)) },
      ...assets.map((asset) => ({ path: asset.uri.split('://')[1]!, data: mockAudio })),
    ])
    expect((await importCharacter(zip)).name).toBe('Audio Card')
    expect(listAudioTracks().find((v) => v.name === 'Night Forest (2)')?.kind).toBe('bgm')
    expect(listAudioTracks().find((v) => v.name === 'bell')?.kind).toBe('sfx')
    expect(listAudioTracks().find((v) => v.name === 'Sunset')?.kind).toBe('bgm')
    const jsonCard = {
      ...card,
      data: {
        name: 'V3',
        assets: [
          { name: 'Data audio', ext: 'wav', uri: `data:audio/wav;base64,${Buffer.from(mockAudio).toString('base64')}` },
        ],
      },
    }
    await importCharacter(Buffer.from(JSON.stringify(jsonCard)))
    expect(listAudioTracks().some((v) => v.name === 'Data audio')).toBe(true)
  } finally {
    sqlite.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
