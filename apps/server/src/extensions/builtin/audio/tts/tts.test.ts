import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatVoiceDTO, TtsLineResult, VoiceRef } from '@nobot/shared'

test('AUD2：引擎协议、声音解析、分段、缓存并发、草稿密钥与 Range', async () => {
  // 配置和数据库都是单例，用子进程避免影响其他扩展测试。
  if (!process.env.AUD2_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, AUD2_TEST_CHILD: '1', TTS_FETCH_MOCK: '1' },
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
  const directory = await mkdtemp(join(tmpdir(), 'nobot-tts-'))
  process.env.DATA_DIR = directory
  await (await import('../../../../bootstrap')).bootstrap()
  const { sqlite } = await import('../../../../db/client')
  const { app } = await import('../../../../app')
  const { updateExtension } = await import('../../../registry')
  const { createCharacter, getCharacter } = await import('../../../../services/characters')
  const { createChat, editMessage } = await import('../../../../services/chats')
  const { createTtsEngines, ttsEngines, mockAudio } = await import('./engines')
  const { audioSettings } = await import('./settings')
  const { cleanTtsText, resolveVoice, poolVoice, cacheEntries, synthesizeVoice, clearTtsCache, messageSegments } =
    await import('./service')
  const { edgeGec, xmlEscape, edgeSynthesize } = await import('./edge')
  const request = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
    app.request(`/api/ext/audio/tts${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const json = async <T>(path: string, body?: unknown, method?: string) => {
    const response = await request(path, body, method)
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json() as Promise<T>
  }
  try {
    updateExtension('audio', { enabled: true })
    const { fishClient, createFishClient } = await import('./fish')
    const clearFish = spyOn(fishClient, 'clearCache')
    updateExtension('audio', { settings: { fishApiKey: 'saved-key' } })
    expect(clearFish).toHaveBeenCalledTimes(1)
    expect(await json('/fish/refresh', {}, 'POST')).toEqual({ ok: true })
    expect(clearFish).toHaveBeenCalledTimes(2)
    clearFish.mockRestore()
    expect(await json('/fish/models', {})).toEqual({
      options: [
        { value: 's2.1-pro', label: 's2.1-pro（推荐）' },
        { value: 's2-pro', label: 's2-pro' },
        { value: 's1', label: 's1' },
      ],
    })
    const { ttsFields: fishFields } = await import('./settings')
    expect(fishFields.find((field) => field.key === 'fishModel')).toMatchObject({
      type: 'string',
      optionsSource: 'tts/fish/models',
    })
    const missingKey = await request('/fish/search', { settings: { fishApiKey: '' } })
    expect(missingKey.status).toBe(400)
    expect(await missingKey.json()).toMatchObject({ error: { message: '请先填写 Fish Audio 密钥' } })
    const fishCalls: { url: string; init?: RequestInit }[] = []
    const injectedFish = createFishClient({
      mock: false,
      fetch: Object.assign(
        async (url: string | URL | Request, init?: RequestInit) => {
          fishCalls.push({ url: String(url), init })
          return Response.json({ items: [{ _id: 'draft-result' }], total: 1 })
        },
        { preconnect: fetch.preconnect },
      ) as typeof fetch,
    })
    const searchFish = spyOn(fishClient, 'search').mockImplementation(injectedFish.search)
    try {
      expect(
        await json('/fish/search', {
          query: 'test',
          language: 'en',
          self: true,
          page: 2,
          settings: { fishApiKey: 'draft-key', fishEndpoint: 'https://custom.example/v1/tts' },
        }),
      ).toMatchObject({ items: [{ id: 'draft-result' }], total: 1, hasMore: false })
      expect(new Headers(fishCalls[0]?.init?.headers).get('Authorization')).toBe('Bearer draft-key')
      expect(Object.fromEntries(new URL(fishCalls[0]!.url).searchParams)).toEqual({
        title: 'test',
        language: 'en',
        self: 'true',
        page_number: '2',
        page_size: '20',
      })
      const failedFish = createFishClient({
        mock: false,
        fetch: Object.assign(async () => new Response('secret-upstream-body', { status: 401 }), {
          preconnect: fetch.preconnect,
        }) as typeof fetch,
      })
      searchFish.mockImplementation(failedFish.search)
      const failed = await request('/fish/search', {})
      expect(failed.status).toBe(502)
      expect(await failed.text()).not.toContain('secret-upstream-body')
      expect((await request('/fish/search', { page: 0 })).status).toBe(400)
      expect((await request('/fish/search', { pageSize: 101 })).status).toBe(400)
    } finally {
      searchFish.mockRestore()
    }
    updateExtension('audio', { settings: {} })
    const character = createCharacter({ name: 'Alice Example', first_mes: 'She smiles. “Hello!” 「Welcome」' })
    const chat = createChat({ characterId: character.id })
    const voice: VoiceRef = { engine: 'openai', voice: 'coral', speed: 1 }
    const settings = audioSettings.parse({ npcVoices: [voice], openaiApiKey: 'secret' })
    expect((await request('/line', { chatId: chat.id, speaker: { kind: 'narrator' }, text: '' })).status).toBe(400)
    expect(await json(`/voice/character/${character.id}`, { voice }, 'PUT')).toEqual(voice)
    expect(getCharacter(character.id).extensions.nobot_tts).toEqual(voice)
    expect(await json(`/voice/character/${character.id}`)).toEqual(voice)
    expect(resolveVoice(chat.id, { kind: 'npc', name: 'Alice' }, settings)).toEqual(voice)
    expect(resolveVoice(chat.id, { kind: 'character', characterId: character.id }, settings)).toEqual(voice)
    expect(resolveVoice(chat.id, { kind: 'user' }, settings)).toEqual({ kind: 'skip', reason: 'user-off' })
    expect(resolveVoice(chat.id, { kind: 'narrator' }, settings)).toEqual({ kind: 'skip', reason: 'narration-off' })
    expect(poolVoice(' A B ', [voice])).toEqual(poolVoice('ab', [voice]))
    expect(poolVoice('npc', [])).toBeNull()
    const unvoiced = createCharacter({ name: 'No Voice' })
    const narrator: VoiceRef = { engine: 'browser', voice: 'narrator', speed: 1 }
    for (const speaker of [
      { kind: 'npc' as const, name: 'Stranger' },
      { kind: 'character' as const, characterId: unvoiced.id },
      { kind: 'npc' as const, name: character.name },
    ]) {
      // 已设卡片声音的成员仍然优先使用卡片，其余才借用旁白。
      const expected = speaker.kind === 'npc' && speaker.name === character.name ? voice : narrator
      const fallback = { ...audioSettings.parse({ narratorVoice: narrator }), readNarration: false }
      expect(resolveVoice(chat.id, speaker, fallback)).toEqual(expected)
      if (expected === narrator) {
        expect(
          resolveVoice(chat.id, speaker, {
            ...fallback,
            chatVoice: { characters: {}, npcs: {}, narratorVoice: null },
          }),
        ).toEqual({ kind: 'skip', reason: 'no-voice' })
        expect(resolveVoice(chat.id, speaker, { ...fallback, npcVoices: [voice] })).toEqual(voice)
        expect(
          resolveVoice(chat.id, speaker, {
            ...fallback,
            chatVoice: { characters: {}, npcs: {}, narratorVoice: voice },
          }),
        ).toEqual(voice)
      }
    }

    const fallbackChat = createChat({ characterId: unvoiced.id })
    const { writeTemporaryActor: addFallbackNpc } = await import('../../../../services/temporary-actors')
    addFallbackNpc(fallbackChat.id, 'Stranger', {
      key: 'stranger',
      name: 'Stranger',
      image: null,
      prompt: '',
      status: 'done',
      updatedAt: 0,
    })
    updateExtension('audio', { settings: { narratorVoice: narrator, npcVoices: [] } })
    const fallbackDTO = await json<ChatVoiceDTO>(`/chat/${fallbackChat.id}`)
    expect(fallbackDTO.members[0]).toMatchObject({ cardVoice: null, fallbackVoice: narrator })
    expect(fallbackDTO.npcs[0]).toMatchObject({ poolVoice: null, fallbackVoice: narrator })
    const mutedDTO = await json<ChatVoiceDTO>(`/chat/${fallbackChat.id}`, { narratorVoice: null }, 'PUT')
    expect(mutedDTO.members[0]?.fallbackVoice).toBeNull()
    expect(mutedDTO.npcs[0]?.fallbackVoice).toBeNull()
    expect(cleanTtsText('<scene bg="night" />\n<b>*Hi_*</b>')).toBe('Hi')
    const page = (await import('../../../../services/chats')).getChatPage(chat.id, {}, false)
    const opening = page.messages[0]!
    const segments = messageSegments(opening.id).segments
    expect(segments.filter((s) => s.speaker.kind === 'character').map((s) => s.text)).toEqual(['Hello!', 'Welcome'])
    editMessage(opening.id, 'Alice[joy]：「Hi」\nA quiet night.')
    expect(messageSegments(opening.id).segments[0]).toMatchObject({
      speaker: { kind: 'npc', name: 'Alice' },
      text: '「Hi」',
      expression: 'joy',
    })
    const narration = '她笑着说：「你好呀。」然后转身离开。'
    const expectedSegments = [
      { speaker: { kind: 'narrator' }, text: '她笑着说：' },
      { speaker: { kind: 'character', characterId: character.id }, text: '你好呀。' },
      { speaker: { kind: 'narrator' }, text: '然后转身离开。' },
    ]
    updateExtension('audio', { settings: { ...settings, ttsEnabled: true } })
    editMessage(opening.id, narration)
    expect(await json('/message', { messageId: opening.id })).toEqual({ chatId: chat.id, segments: expectedSegments })
    // 显式保存舞台拍，覆盖 /tts/message 读取 meta.stage 而非重新解析的路径。
    sqlite
      .query('UPDATE messages SET meta = ? WHERE id = ?')
      .run(
        JSON.stringify({ ...opening.meta, stage: { v: 1, beats: [{ kind: 'narration', text: narration }], ops: [] } }),
        opening.id,
      )
    expect(await json('/message', { messageId: opening.id })).toEqual({ chatId: chat.id, segments: expectedSegments })
    const { ttsFields } = await import('./settings')
    const edgeHeading = ttsFields.find((field) => field.key === 'edge')!
    expect(edgeHeading.hint).toBe('Edge 使用非官方接口，可能随时失效')
    expect(ttsFields[ttsFields.indexOf(edgeHeading) + 1]).toMatchObject({ key: 'edgeVolume', type: 'number' })
    updateExtension('audio', { settings: { ...settings, ttsEnabled: true } })
    expect(
      await json('/line', { chatId: chat.id, speaker: { kind: 'narrator' }, text: '<scene bg="night" />' }),
    ).toEqual({ kind: 'skip', reason: 'empty' })
    // 会话覆盖只影响本会话，候选名单保留声音池原本的分配结果。
    const otherChat = createChat({ characterId: character.id })
    const override: VoiceRef = { engine: 'browser', voice: 'session', speed: 1.2 }
    updateExtension('audio', { settings: { ...settings, ttsEnabled: true, readNarration: true, narratorVoice: voice } })
    const before = await json<ChatVoiceDTO>(`/chat/${chat.id}`)
    expect(before.config).toEqual({ characters: {}, npcs: {} })
    expect(before.effective.enabled).toBe(true)
    expect(before.members).toEqual([{ id: character.id, name: character.name, cardVoice: voice, fallbackVoice: voice }])
    const { writeTemporaryActor } = await import('../../../../services/temporary-actors')
    for (const name of ['Bob', ' B ob ', 'Alice', 'Saved']) {
      writeTemporaryActor(chat.id, name, { key: name, name, image: null, prompt: '', status: 'done', updatedAt: 0 })
    }
    const { getChatRow, loadPath } = await import('../../../../services/chats')
    const { computeStage } = await import('../../../../services/stage')
    const currentStage = computeStage(chat.id, loadPath(getChatRow(chat.id).activeLeafId))
    const stageSpy = spyOn(await import('../../../../services/stage'), 'computeStage').mockReturnValue({
      scene: currentStage?.scene ?? {},
      cast: [
        { key: 'bob', name: 'Bob', at: 'center', expression: '' },
        { key: 'stageonly', name: 'Stage Only', at: 'center', expression: '' },
      ],
    })
    const config = {
      enabled: true,
      autoRead: true,
      vnVoice: false,
      narratorVoice: null,
      characters: { [character.id]: override },
      npcs: { bob: override, saved: override },
    }
    const saved = await json<ChatVoiceDTO>(`/chat/${chat.id}`, config, 'PUT')
    stageSpy.mockRestore()
    expect(saved.effective).toEqual({
      enabled: true,
      autoRead: true,
      vnVoice: false,
      vnWaitVoice: true,
      vnInterrupt: true,
    })
    expect(saved.npcs.map((npc) => npc.key).sort()).toEqual(['bob', 'saved', 'stageonly'])
    expect(saved.npcs.every((npc) => JSON.stringify(npc.poolVoice) === JSON.stringify(voice))).toBe(true)
    expect(saved.npcs.every((npc) => JSON.stringify(npc.fallbackVoice) === JSON.stringify(voice))).toBe(true)
    expect(saved.global.narratorVoice).toEqual(voice)
    expect(
      await json('/line', { chatId: chat.id, speaker: { kind: 'character', characterId: character.id }, text: 'Hi' }),
    ).toMatchObject({ kind: 'browser', voice: 'session' })
    expect(await json('/line', { chatId: chat.id, speaker: { kind: 'npc', name: 'Alice' }, text: 'Hi' })).toMatchObject(
      { kind: 'browser', voice: 'session' },
    )
    expect(await json('/line', { chatId: chat.id, speaker: { kind: 'npc', name: 'B ob' }, text: 'Hi' })).toMatchObject({
      kind: 'browser',
      voice: 'session',
    })
    expect(await json('/line', { chatId: chat.id, speaker: { kind: 'narrator' }, text: 'Hi' })).toEqual({
      kind: 'skip',
      reason: 'no-voice',
    })
    await json(`/chat/${chat.id}`, { enabled: false }, 'PUT')
    const disabled = await request('/line', { chatId: chat.id, speaker: { kind: 'narrator' }, text: 'Hi' })
    expect(disabled.status).toBe(400)
    expect(await disabled.json()).toMatchObject({ error: { code: 'TTS_DISABLED', message: '还没有开启朗读' } })
    expect((await request('/message', { messageId: opening.id })).status).toBe(400)
    expect((await json<ChatVoiceDTO>(`/chat/${otherChat.id}`)).effective.enabled).toBe(true)
    expect((await json<ChatVoiceDTO>(`/chat/${chat.id}`, undefined, 'DELETE')).config).toEqual({
      characters: {},
      npcs: {},
    })
    expect((await json<ChatVoiceDTO>(`/chat/${chat.id}`)).effective.enabled).toBe(true)
    const { setSetting } = await import('../../../../db/client')
    setSetting(`extdata:audio:tts-chat:${chat.id}`, {
      autoRead: true,
      narratorVoice: { engine: 'browser', voice: '' },
      characters: { draft: { engine: 'browser', voice: '' } },
    })
    expect((await json<ChatVoiceDTO>(`/chat/${chat.id}`)).config).toEqual({ autoRead: true, characters: {}, npcs: {} })
    setSetting(`extdata:audio:tts-chat:${chat.id}`, { enabled: 'bad' })
    expect((await json<ChatVoiceDTO>(`/chat/${chat.id}`)).config).toEqual({ characters: {}, npcs: {} })
    await json(`/chat/${chat.id}`, undefined, 'DELETE')
    const synthesis = spyOn(ttsEngines.openai, 'synthesize')
    const results = await Promise.all(
      Array.from({ length: 4 }, () => synthesizeVoice(voice, 'Hello cache', settings, 'joy')),
    )
    expect(synthesis).toHaveBeenCalledTimes(1)
    expect(results.every((r) => JSON.stringify(r) === JSON.stringify(results[0]))).toBe(true)
    const result = results[0] as Extract<TtsLineResult, { kind: 'audio' }>
    const range = await app.request(result.url, { headers: { Range: 'bytes=0-3' } })
    expect(range.status).toBe(206)
    expect(await range.text()).toBe('RIFF')
    expect(await cacheEntries()).toHaveLength(1)
    await synthesizeVoice(voice, 'Hello cache', settings, 'joy')
    expect(synthesis).toHaveBeenCalledTimes(1)
    await synthesizeVoice(voice, 'Hello cache', { ...settings, openaiModel: 'tts-1' })
    expect(synthesis).toHaveBeenCalledTimes(2)
    synthesis.mockRestore()
    expect(await json('/preview', { voice: { engine: 'browser', voice: 'system', speed: 1 } })).toMatchObject({
      kind: 'browser',
      text: '你好，这是声音试听。',
    })
    expect(await json('/engines')).toHaveLength(9)
    expect(await json('/voices', { engine: 'openai' })).toMatchObject({
      options: expect.arrayContaining([{ value: 'verse', label: 'verse' }]),
    })
    await json('/cache', undefined, 'DELETE')
    expect(await json('/cache')).toEqual({ bytes: 0, files: 0 })

    const calls: { url: string; init?: RequestInit }[] = []
    const engines = createTtsEngines({
      mock: false,
      fetch: Object.assign(
        async (url: string | URL | Request, init?: RequestInit) => {
          calls.push({ url: String(url), init })
          if (new URL(String(url)).pathname === '/model') return Response.json({ items: [] })
          if (String(url).endsWith('/voices')) return Response.json({ voices: [{ voice_id: 'v1', name: 'Test' }] })
          return new Response(mockAudio)
        },
        { preconnect: fetch.preconnect },
      ) as typeof fetch,
    })
    await engines.openai.synthesize(
      { text: 'Hi', voice: 'coral', speed: 1.1, style: 'Speak with a happy tone.' },
      settings,
    )
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      model: 'gpt-4o-mini-tts',
      voice: 'coral',
      speed: 1.1,
      instructions: 'Speak with a happy tone.',
      response_format: 'mp3',
    })
    await engines.openai.synthesize(
      { text: 'Hi', voice: 'coral', speed: 1, style: 'style' },
      { ...settings, openaiModel: 'tts-1' },
    )
    expect(JSON.parse(String(calls[1]?.init?.body))).not.toHaveProperty('instructions')
    const sovits = audioSettings.parse({ gptsovitsVoices: [{ id: 'test', name: 'Test', refAudioPath: '/ref.wav' }] })
    await engines.gptsovits.synthesize({ text: 'Hi', voice: 'test', speed: 1.2 }, sovits)
    expect(JSON.parse(String(calls[2]?.init?.body))).toMatchObject({
      text_lang: 'auto',
      prompt_lang: 'zh',
      speed_factor: 1.2,
      streaming_mode: false,
      media_type: 'wav',
    })
    expect(await engines.elevenlabs.voices({ ...settings, elevenlabsApiKey: 'eleven-secret' })).toEqual([
      { value: 'v1', label: 'Test' },
    ])
    await engines.elevenlabs.synthesize({ text: 'Hi', voice: 'a/b', speed: 1.2 }, settings)
    expect(calls.at(-1)?.url).toContain('a%2Fb?output_format=mp3_44100_128')
    // Fish Audio：模型放在请求头，声音 ID 走 reference_id，语速放进 prosody
    const fish = audioSettings.parse({ fishApiKey: 'fish-secret', fishVoices: [{ id: 'ref-1', name: 'Test' }] })
    expect(engines.fish.configured(fish)).toBe(true)
    expect(await engines.fish.voices(fish)).toEqual([{ value: 'ref-1', label: 'Test' }])
    await engines.fish.synthesize({ text: 'Hi', voice: 'ref-1', speed: 1.2 }, fish)
    expect(calls.at(-1)?.url).toBe('https://api.fish.audio/v1/tts')
    expect(new Headers(calls.at(-1)?.init?.headers).get('model')).toBe('s2.1-pro')
    expect(new Headers(calls.at(-1)?.init?.headers).get('authorization')).toBe('Bearer fish-secret')
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({
      text: 'Hi',
      reference_id: 'ref-1',
      prosody: { speed: 1.2 },
      format: 'mp3',
    })
    // 地址填错、模型清空时退回默认值，不让整份音频设置解析失败
    expect(audioSettings.parse({ fishEndpoint: 'not a url', fishModel: '' })).toMatchObject({
      fishEndpoint: 'https://api.fish.audio/v1/tts',
      fishModel: 's2.1-pro',
    })
    expect(engines.openai.configured(audioSettings.parse({}))).toBe(false)
    expect(edgeGec(0)).toBe('52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6')
    expect(xmlEscape('<&>"\'')).toBe('&lt;&amp;&gt;&quot;&apos;')
    const sent: string[] = []
    const socket = {
      binaryType: '',
      close() {},
      send: (text: string) => sent.push(text),
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    } as unknown as WebSocket
    const audio = edgeSynthesize({ text: '<Hi>', voice: 'voice', speed: 1.2, volume: -15 }, undefined, () => socket)
    socket.onopen?.(new Event('open'))
    expect(sent[0]).toContain('Path:speech.config')
    expect(sent[1]).toContain('rate="+20%"')
    expect(sent[1]).toContain('&lt;Hi&gt;')
    expect(sent[1]).toContain('volume="-15%"')
    expect(sent[1]).toMatch(/X-RequestId:[a-f0-9]{32}\r\n/)
    const header = Buffer.from('Path:audio\r\n')
    const frame = Buffer.alloc(2 + header.length + 3)
    frame.writeUInt16BE(header.length)
    header.copy(frame, 2)
    frame.set([1, 2, 3], 2 + header.length)
    socket.onmessage?.(
      new MessageEvent('message', { data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.length) }),
    )
    socket.onmessage?.(new MessageEvent('message', { data: 'Path:turn.end\r\n\r\n' }))
    expect((await audio).bytes).toEqual(new Uint8Array([1, 2, 3]))
    const abort = new AbortController()
    const aborted = edgeSynthesize({ text: 'Hi', voice: 'voice', speed: 1 }, abort.signal, () => socket)
    abort.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    let timeoutCallback: (() => void) | undefined
    const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
      expect(delay).toBe(30000)
      timeoutCallback = callback
      return 0
    }) as unknown as typeof setTimeout)
    try {
      const timedOut = edgeSynthesize({ text: 'Hi', voice: 'voice', speed: 1 }, undefined, () => socket)
      socket.onopen?.(new Event('open'))
      timeoutCallback!()
      await expect(timedOut).rejects.toThrow('Edge 朗读失败，接口可能已变化')
    } finally {
      timeout.mockRestore()
    }
    await clearTtsCache()
    const smallCache = { ...settings, cacheMaxMb: 0.00006 }
    await synthesizeVoice(voice, 'old', smallCache)
    // atime 作为访问顺序，刻意设成过去，避免文件系统时间精度影响淘汰断言。
    const old = (await cacheEntries())[0]!
    const { utimes } = await import('node:fs/promises')
    await utimes(join(directory, 'users/test/tts-cache', old.name), new Date(0), new Date(0))
    await synthesizeVoice(voice, 'new', smallCache)
    for (let attempt = 0; attempt < 100 && (await cacheEntries()).length > 1; attempt++) await Bun.sleep(1)
    const remaining = await cacheEntries()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.name).not.toBe(old.name)
    expect(remaining[0]!.bytes).toBeLessThanOrEqual(0.00006 * 1024 * 1024)
    await clearTtsCache()
  } finally {
    sqlite.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
