import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('CH2a：ASR 限制、宿主合成、媒体缓存、入站附件、隐私、按钮和状态卡', async () => {
  if (!process.env.CH2_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, CH2_TEST_CHILD: '1', TTS_FETCH_MOCK: '1', ASR_FETCH_MOCK: '1' },
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
  const directory = await mkdtemp(join(tmpdir(), 'nobot-ch2-'))
  process.env.DATA_DIR = directory
  await (await import('../src/bootstrap')).bootstrap()
  const { Hono } = await import('hono')
  const sharp = (await import('sharp')).default
  const { channelAccountInput, channelBindingInput, channelSettingsSchema } = await import('@nobot/shared')
  const { db, getSetting, setSetting, newId } = await import('../src/db/client')
  const { channelActors, channelActions } = await import('../src/db/schema')
  const { currentUser } = await import('../src/user-context')
  const { systemDatabase } = await import('../src/db/system-client')
  const { users } = await import('../src/db/system-schema')
  systemDatabase()
    .insert(users)
    .values({ ...currentUser(), passwordHash: 'unused', createdAt: Date.now() })
    .onConflictDoNothing()
    .run()
  const { createCharacter } = await import('../src/services/characters')
  const { createChat, loadPath, getChatRow } = await import('../src/services/chats')
  const { saveSprite } = await import('../src/services/sprites/sprites')
  const { createExtensionHost } = await import('../src/extensions/host')
  const { ChannelService } = await import('../src/extensions/builtin/channels/service')
  const { bindingRow } = await import('../src/extensions/builtin/channels/store')
  const { prepareAudio, readMediaAsset } = await import('../src/extensions/builtin/channels/adapters/telegram/media')
  const { transcribe, asrNetwork } = await import('../src/extensions/builtin/audio/asr/service')
  const { registerAsrRoutes } = await import('../src/extensions/builtin/audio/asr/routes')
  const { mockAudio } = await import('../src/extensions/builtin/audio/tts/engines')
  const { HttpError } = await import('../src/errors')
  const settings: Record<string, unknown> = {
    asrEngine: 'openai-compatible',
    ttsEnabled: true,
    openaiApiKey: 'secret',
    genderMatch: false,
    narratorVoice: { engine: 'openai', voice: 'alloy', speed: 1 },
    readNarration: true,
  }
  const storage = {
    get: <T>(key: string) => getSetting<T>(`ch2:${key}`),
    set: (key: string, value: unknown) => setSetting(`ch2:${key}`, value),
    delete: () => {},
  }
  const host = createExtensionHost(
    () => {},
    () => ({ settings, storage }),
  )
  const service = new ChannelService(host, () => ({}))
  try {
    expect(await createExtensionHost(() => {}).transcribe(mockAudio, 'audio/wav')).toMatchObject({
      kind: 'unavailable',
    })
    expect(await transcribe(mockAudio, 'audio/wav', {})).toMatchObject({ kind: 'unavailable' })
    expect(await host.transcribe(mockAudio, 'audio/wav')).toMatchObject({ text: '这是一条测试语音。' })
    await expect(transcribe(mockAudio, 'audio/wav', settings, { durationMs: 121000 })).rejects.toMatchObject({
      code: 'AUDIO_TOO_LONG',
    })
    await expect(
      transcribe(new Uint8Array(2048), 'audio/ogg', { ...settings, asrMaxSizeMb: 0.001 }),
    ).rejects.toMatchObject({ status: 413 })
    await expect(transcribe(mockAudio, 'text/plain', settings)).rejects.toMatchObject({ code: 'BAD_AUDIO' })
    asrNetwork.fetch = (async (_url, init) => {
      expect(String(_url)).toEndWith('/audio/transcriptions')
      const form = init?.body as FormData
      expect(form.get('file')).toBeInstanceOf(File)
      expect(form.get('language')).toBe('en')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-key')
      return Response.json({ text: ' actual transcript ', language: 'en', duration: 2 })
    }) as typeof fetch
    expect(
      await transcribe(
        new Uint8Array([1, 2, 3]),
        'audio/ogg',
        { ...settings, asrApiKey: 'test-key' },
        { language: 'en' },
      ),
    ).toMatchObject({ text: 'actual transcript', durationMs: 2000 })
    asrNetwork.fetch = undefined
    const app = new Hono()
    app.onError((err, c) => c.json({ error: err.message }, err instanceof HttpError ? err.status : 500))
    registerAsrRoutes(app, { settings })
    const upload = async (durationMs = '1000') => {
      const form = new FormData()
      form.set('file', new Blob([mockAudio], { type: 'audio/wav' }), 'test.wav')
      form.set('durationMs', durationMs)
      return app.request('/transcribe', { method: 'POST', body: form })
    }
    expect((await upload('121000')).status).toBe(400)
    expect((await upload()).status).toBe(200)
    for (let i = 0; i < 8; i++) await upload()
    expect((await upload()).status).toBe(429)
    expect((await prepareAudio(mockAudio, 'audio/wav', { detect: () => null })).method).toBe('sendAudio')
    expect((await prepareAudio(mockAudio, 'audio/mpeg', { detect: () => null })).method).toBe('sendVoice')
    let convertedPath = ''
    const converted = await prepareAudio(mockAudio, 'audio/wav', {
      detect: () => 'stub',
      convert: async (_input, output) => {
        convertedPath = output
        await Bun.write(output, 'opus')
      },
    })
    expect(converted.mime).toBe('audio/ogg')
    expect(await Bun.file(convertedPath).exists()).toBe(false)
    const character = createCharacter({ name: 'Alice' })
    const chat = createChat({ characterId: character.id })
    const message = host.appendMessage(chat.id, {
      role: 'assistant',
      speakerId: character.id,
      content: '<say who="Alice">Hello.</say>',
    })
    const speech = await host.synthesizeSpeech(chat.id, message.id)
    expect(speech.kind).toBe('audio')
    expect(await host.synthesizeSpeech(chat.id, message.id)).toEqual(speech)
    settings.ttsEnabled = false
    expect(await host.synthesizeSpeech(chat.id, message.id)).toMatchObject({ reason: 'tts-disabled' })
    settings.ttsEnabled = true
    const calls: { method: string; body: Record<string, unknown>; multipart: boolean }[] = []
    const image = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#ff000080' } })
      .png()
      .toBuffer()
    let seq = 100
    let pinAllowed = true
    service.runtime.fetch = async (input, init) => {
      if (String(input).includes('/file/bot')) return new Response(String(input).endsWith('.png') ? image : mockAudio)
      const method = String(input).split('/').at(-1)!
      const multipart = init?.body instanceof FormData
      const body = multipart
        ? Object.fromEntries((init.body as FormData).entries())
        : (JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      calls.push({ method, body, multipart })
      if (method === 'pinChatMessage' && !pinAllowed) return Response.json({ ok: false, error_code: 403 })
      return Response.json({
        ok: true,
        result:
          method === 'getMe'
            ? { id: 99, is_bot: true, username: 'media_bot' }
            : method === 'getFile'
              ? { file_path: String(body.file_id).includes('photo') ? 'photos/a.png' : 'voice/a.ogg' }
              : method === 'getChatMember'
                ? { status: 'administrator', can_pin_messages: pinAllowed }
                : method.startsWith('send')
                  ? {
                      message_id: ++seq,
                      photo: [{ file_id: 'cached-photo' }],
                      document: { file_id: 'cached-doc' },
                      voice: { file_id: 'cached-voice' },
                      audio: { file_id: 'cached-audio' },
                    }
                  : true,
      })
    }
    const account = await service.runtime.create(
      channelAccountInput.parse({
        name: 'Media',
        credentials: { token: 'mock', webhookSecret: 'test-secret' },
        receiveMode: 'webhook',
        webhookUrl: 'https://example.test/hooks',
        defaultCharacterId: character.id,
        policies: { newLocation: { private: 'auto', group: 'auto' } },
      }),
    )
    await service.runtime.start(account.id)
    const actor = db
      .insert(channelActors)
      .values({
        id: newId(),
        provider: 'telegram',
        externalId: '11',
        displayName: 'Owner',
        role: 'owner',
        linkedUserId: currentUser().id,
      })
      .returning()
      .get()
    const binding = {
      ...channelBindingInput.parse({
        accountId: account.id,
        scope: 'private',
        chat: '11',
        chatId: chat.id,
        state: 'active',
        trigger: 'all',
      }),
      id: newId(),
      memberCount: 0,
      chatTitle: '',
      lastActivityAt: Date.now(),
      createdBy: currentUser().id,
      idleWarnedAt: null,
    }
    service.saveBinding(binding)
    const client = service.runtime.accounts.get(account.id)!.client
    const assistant = { ...message, status: 'done' as const }
    const mediaSettings = channelSettingsSchema.parse({
      voice: 'auto',
      sprites: 'changes',
      cg: 'spoiler',
      statusCard: 'pinned',
    })
    const sprite = await saveSprite(character.id, image, '', 'joy')
    expect(sprite.expression).toBe('joy')
    const attachment = await host.saveImage(image)
    const rich = {
      ...assistant,
      content: '<expr who="Alice" v="joy"/><say who="Alice">Hello.</say><state>hp=5</state>',
      meta: { ...assistant.meta, images: [{ ...attachment, isCg: true }], varsPatch: { hp: 5 } },
    }
    await service.media.deliver(binding, rich, mediaSettings, client, account.id)
    expect(calls.some((c) => c.method === 'sendPhoto' && String(c.body.has_spoiler) === 'true')).toBe(true)
    expect(calls.some((c) => c.method === 'sendDocument' && c.multipart)).toBe(true)
    expect(calls.some((c) => ['sendVoice', 'sendAudio'].includes(c.method))).toBe(true)
    expect(calls.some((c) => c.method === 'pinChatMessage')).toBe(true)
    const count = calls.length
    await service.media.deliver(binding, rich, mediaSettings, client, account.id)
    expect(calls.length).toBe(count)
    await service.media.deliver(
      binding,
      { ...rich, id: 'another', meta: { ...rich.meta, varsPatch: { hp: 4 } } },
      mediaSettings,
      client,
      account.id,
    )
    expect(calls.filter((c) => c.method === 'sendDocument').length).toBe(1)
    expect(calls.some((c) => c.method === 'sendPhoto' && c.body.photo === 'cached-photo')).toBe(true)
    expect(calls.some((c) => c.method === 'editMessageText' && String(c.body.text).includes('hp: 4'))).toBe(true)
    const privateCount = calls.length
    await service.media.deliver(
      { ...binding, scope: 'group' },
      { ...rich, meta: { ...rich.meta, visibility: { level: 'blind', userId: 'other' } } } as typeof rich,
      mediaSettings,
      client,
      account.id,
    )
    expect(calls.length).toBe(privateCount)
    pinAllowed = false
    const fallbackBinding = { ...binding, id: 'fallback' }
    await service.media.deliver(
      fallbackBinding,
      { ...rich, id: 'fallback-msg' },
      { ...mediaSettings, voice: 'off', sprites: 'off' },
      client,
      account.id,
    )
    expect(calls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('blockquote expandable'))).toBe(
      true,
    )
    await service.deliver(binding, assistant)
    const action = db
      .select()
      .from(channelActions)
      .all()
      .find((a) => a.action === 'speak')!
    expect(action).toBeDefined()
    const originalSpeech = host.synthesizeSpeech
    const mp3Path = join(directory, 'test.mp3')
    await Bun.write(mp3Path, new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]))
    host.synthesizeSpeech = async () => ({
      kind: 'audio',
      files: [
        { path: mp3Path, mime: 'audio/mpeg', text: 'Hello.', speakerId: character.id, speakerName: character.name },
      ],
    })
    const beforeSpeak = calls.filter((c) => ['sendVoice', 'sendAudio'].includes(c.method)).length
    await service.receive(account.id, {
      update_id: 1,
      callback_query: {
        id: 'speak',
        from: { id: 11 },
        data: action.token,
        message: { message_id: 1, chat: { id: 11, type: 'private' } },
      },
    })
    expect(calls.filter((c) => ['sendVoice', 'sendAudio'].includes(c.method)).length).toBeGreaterThan(beforeSpeak)
    expect(calls.some((c) => c.method === 'sendVoice')).toBe(true)
    host.synthesizeSpeech = originalSpeech
    const generated: unknown[] = []
    const originalGenerate = host.generate
    host.generate = ((_id, input) => {
      generated.push(input)
      return 'job'
    }) as typeof host.generate
    const incoming = (extra: Record<string, unknown>) => ({
      update_id: ++seq,
      message: { message_id: seq, chat: { id: 11, type: 'private' }, from: { id: 11, first_name: 'Owner' }, ...extra },
    })
    await service.receive(account.id, incoming({ voice: { file_id: 'voice', duration: 1, mime_type: 'audio/ogg' } }))
    expect(generated.at(-1)).toMatchObject({ text: '这是一条测试语音。' })
    expect(calls.some((c) => String(c.body.text).startsWith('🎤'))).toBe(false)
    await service.receive(account.id, incoming({ caption: 'look', photo: [{ file_id: 'photo', width: 4, height: 4 }] }))
    expect(generated.at(-1)).toMatchObject({ text: 'look', images: [expect.any(String)] })
    const beforeAlbum = generated.length
    for (const caption of ['one', 'two'])
      await service.receive(
        account.id,
        incoming({ media_group_id: 'album', caption, photo: [{ file_id: 'photo', width: 4, height: 4 }] }),
      )
    await Bun.sleep(1700)
    expect(generated.length).toBe(beforeAlbum + 1)
    expect(generated.at(-1)).toMatchObject({ text: 'one\ntwo', images: [expect.any(String), expect.any(String)] })
    host.generate = originalGenerate
    const { createRoom } = await import('../src/services/rooms')
    const { createRoomInput } = await import('@nobot/shared')
    const groupChat = createChat({ characterId: character.id })
    const room = createRoom(createRoomInput.parse({ name: 'Media room', chatId: groupChat.id }))
    const group = {
      ...binding,
      id: newId(),
      roomId: room.id,
      chatId: groupChat.id,
      scope: 'group' as const,
      chat: '-11',
      isolation: 'shared' as const,
      trigger: 'command' as const,
      settings: { diceAnimation: true },
    }
    service.saveBinding(group)
    const groupInput = (extra: Record<string, unknown>) => incoming({ ...extra, chat: { id: -11, type: 'supergroup' } })
    await service.receive(account.id, groupInput({ voice: { file_id: 'voice', duration: 1 } }))
    expect(
      calls.some((c) => c.body.chat_id === '-11' && String(c.body.text).startsWith('🎤') && c.body.reply_parameters),
    ).toBe(true)
    await service.receive(
      account.id,
      groupInput({ caption: 'room image', photo: [{ file_id: 'photo', width: 4, height: 4 }] }),
    )
    const roomHistory = loadPath(getChatRow(groupChat.id).activeLeafId)
    expect(roomHistory.some((m) => m.content === 'room image' && m.meta.images?.length === 1)).toBe(true)
    const beforeRoll = calls.length
    await service.receive(account.id, groupInput({ text: '/roll d20 public' }))
    const diceCalls = calls.slice(beforeRoll)
    const diceIndex = diceCalls.findIndex((c) => c.method === 'sendDice')
    expect(diceIndex).toBeGreaterThan(0)
    expect(diceCalls.slice(0, diceIndex).some((c) => c.method === 'sendMessage' && c.body.chat_id === '-11')).toBe(true)
    const pendingImage = host.appendMessage(chat.id, {
      role: 'assistant',
      content: '',
      meta: { imageGen: { status: 'pending', mode: 'free' } },
    })
    await service.deliver(binding, pendingImage)
    expect(calls.some((c) => c.method === 'sendChatAction' && c.body.action === 'upload_photo')).toBe(true)
    const ready = host.updateMessageMeta(pendingImage.id, {
      images: [attachment],
      imageGen: { status: 'done', mode: 'free' },
    })
    const beforePhoto = calls.filter((c) => c.method === 'sendPhoto').length
    service.onEvent({ type: 'message:updated', message: ready })
    await Bun.sleep(1800)
    expect(calls.filter((c) => c.method === 'sendPhoto').length).toBeGreaterThan(beforePhoto)
    const failedImage = host.appendMessage(chat.id, {
      role: 'assistant',
      content: 'Text survives media failure',
      meta: {
        images: [{ ...attachment, id: 'missing', url: '/api/assets/attachments/missing.webp' }],
      },
    })
    await service.deliver(binding, failedImage)
    expect(
      calls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('Text survives media failure')),
    ).toBe(true)
    expect(await readMediaAsset('/api/assets/attachments/../../secret')).toBeNull()
    expect(bindingRow(binding.id).state).toBe('active')
    expect(actor.role).toBe('owner')
    expect(loadPath(getChatRow(chat.id).activeLeafId).length).toBeGreaterThan(0)
  } finally {
    asrNetwork.fetch = undefined
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
