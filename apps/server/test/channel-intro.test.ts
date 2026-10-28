import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('公开简介：重试、缓存、来源选择、双语上传与强制重新生成', async () => {
  if (!process.env.INTRO_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, INTRO_TEST_CHILD: '1' },
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
  const directory = await mkdtemp(join(tmpdir(), 'nobot-intro-'))
  process.env.DATA_DIR = directory
  const { channelAccountInput } = await import('@nobot/shared')
  const { eq } = await import('drizzle-orm')
  const { db } = await import('../src/db/client')
  const { systemDatabase } = await import('../src/db/system-client')
  const { users } = await import('../src/db/system-schema')
  systemDatabase()
    .insert(users)
    .values({ id: 'test', handle: 'test', name: 'Test', passwordHash: 'unused', createdAt: Date.now() })
    .run()
  const { channelAccounts } = await import('../src/db/schema')
  const { createCharacter, getCharacter, updateCharacter } = await import('../src/services/characters')
  const { createExtensionHost } = await import('../src/extensions/host')
  const { channelService } = await import('../src/extensions/builtin/channels')
  const { accountRow } = await import('../src/extensions/builtin/channels/store')
  const { desiredPresence } = await import('../src/extensions/builtin/channels/presence')
  const { setAppSettings } = await import('../src/services/settings')
  const host = createExtensionHost(() => {})
  const service = channelService({
    host,
    settings: {},
    storage: { get: () => undefined, set: () => {}, delete: () => {} },
  })
  const calls: { method: string; body: Record<string, unknown> }[] = []
  service.runtime.fetch = async (input, init) => {
    const method = String(input).split('/').at(-1)!
    calls.push({ method, body: JSON.parse(String(init?.body ?? '{}')) })
    return Response.json({
      ok: true,
      result:
        method === 'getMe'
          ? { id: 123, first_name: 'Current', is_bot: true }
          : method === 'getUserProfilePhotos'
            ? { photos: [] }
            : method.startsWith('getMy')
              ? {}
              : true,
    })
  }
  const valid = {
    zh: { short: '开朗的旅伴。', long: '一位喜欢分享故事的开朗旅伴。' },
    en: { short: 'A cheerful companion.', long: 'A cheerful companion who enjoys sharing stories.' },
  }
  const complete = spyOn(host, 'complete').mockResolvedValue(JSON.stringify(valid))
  try {
    const character = createCharacter({
      name: 'Kana',
      description: '[Kana: cheerful, curious]',
      system_prompt: 'PRIVATE_SYSTEM',
      mes_example: 'PRIVATE_EXAMPLE',
    })
    const account = await service.runtime.create(
      channelAccountInput.parse({
        name: 'Intro',
        credentials: { token: 'TEST' },
        presence: {
          characterId: character.id,
          description: { mode: 'follow-character' },
          shortDescription: { mode: 'follow-character' },
        },
      }),
    )
    const presence = service.runtime.presence(account.id)
    complete.mockResolvedValueOnce('bad').mockResolvedValueOnce(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\` trailing`)
    let preview = await presence.preview()
    expect(complete).toHaveBeenCalledTimes(2)
    expect(preview.fields.description?.source).toBe('generated')
    expect(preview.languages.en.shortDescription?.value).toBe(valid.en.short)
    const request = JSON.stringify(complete.mock.calls[0])
    expect(request).not.toContain('PRIVATE_')
    expect(request).not.toContain('chatId')
    await presence.preview()
    expect(complete).toHaveBeenCalledTimes(2)
    expect((getCharacter(character.id).extensions.nobot as Record<string, unknown>).generatedIntro).toBeDefined()
    setAppSettings({ language: 'en' })
    expect((await presence.preview()).desired.description).toBe(valid.en.long)
    await presence.apply(true)
    for (const lang of ['zh', 'en'] as const) {
      expect(
        calls.some(
          (x) =>
            x.method === 'setMyDescription' && x.body.language_code === lang && x.body.description === valid[lang].long,
        ),
      ).toBe(true)
      expect(
        calls.some(
          (x) =>
            x.method === 'setMyShortDescription' &&
            x.body.language_code === lang &&
            x.body.short_description === valid[lang].short,
        ),
      ).toBe(true)
    }
    updateCharacter(character.id, { personality: 'gentle' })
    await presence.preview()
    expect(complete).toHaveBeenCalledTimes(3)
    await presence.regenerateIntro()
    expect(complete).toHaveBeenCalledTimes(4)
    updateCharacter(character.id, {
      extensions: { nobot: { publicIntro: 'Explicit long', publicShortIntro: 'Explicit short' } },
    })
    preview = await presence.preview()
    expect(preview.fields.description?.source).toBe('explicit')
    expect(preview.desired.shortDescription).toBe('Explicit short')
    expect(complete).toHaveBeenCalledTimes(4)
    const mode = (introSource: 'auto' | 'creator-notes' | 'description' | 'model' | 'rules') => {
      const row = accountRow(account.id)
      db.update(channelAccounts)
        .set({
          presence: {
            ...row.config.presence,
            description: { ...row.config.presence.description, introSource },
            shortDescription: { ...row.config.presence.shortDescription, introSource },
          },
        })
        .where(eq(channelAccounts.id, account.id))
        .run()
    }
    mode('rules')
    expect((await presence.preview()).desired.description).toBe('Kana — cheerful, curious')
    mode('description')
    updateCharacter(character.id, { description: '<p>A cheerful friend.</p>' })
    expect((await presence.preview()).desired.description).toBe('A cheerful friend.')
    expect((await presence.preview()).fields.description?.source).toBe('description')
    mode('creator-notes')
    updateCharacter(character.id, { creator_notes: 'A gentle travel companion. Share a relaxed adventure.' })
    expect((await presence.preview()).desired.shortDescription).toBe('A gentle travel companion.')
    expect((await presence.preview()).fields.shortDescription?.source).toBe('creator-notes')
    updateCharacter(character.id, { creator_notes: 'Use with preset X. NSFW.' })
    expect((await presence.preview()).desired.description).toBe('A cheerful friend.')
    expect(complete).toHaveBeenCalledTimes(4)
    mode('model')
    complete.mockResolvedValueOnce('bad').mockResolvedValueOnce('{"zh":{}}')
    preview = await presence.preview()
    expect(complete).toHaveBeenCalledTimes(6)
    expect(preview.fields.description?.source).toBe('description')
    expect(preview.desired.description).toBe('A cheerful friend.')
    mode('auto')
    expect((await presence.preview()).fields.description?.source).toBe('explicit')
    expect(complete).toHaveBeenCalledTimes(6)
    mode('model')
    await presence.regenerateIntro()
    complete.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
    expect((await presence.regenerateIntro()).fields.description?.source).toBe('description')
    expect((getCharacter(character.id).extensions.nobot as Record<string, unknown>).generatedIntro).toBeUndefined()
    const { complete: realComplete } = await import('../src/services/generation/quiet-prompt')
    const { createApiPreset } = await import('../src/services/connections')
    const { introPrompt, introInputs } = await import('../src/extensions/builtin/channels/public-intro')
    createApiPreset({ name: 'Owner default', baseUrl: 'https://intro.test/v1', model: 'intro-model' })
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(String(input)).toContain('intro.test')
      const body = JSON.parse(String(init?.body)) as { messages: unknown[]; stream: boolean }
      expect(body.messages).toEqual([
        { role: 'system', content: introPrompt },
        { role: 'user', content: JSON.stringify(introInputs(getCharacter(character.id))) },
      ])
      expect(body.stream).toBe(false)
      return Response.json({ choices: [{ message: { content: JSON.stringify(valid) } }] })
    })
    try {
      expect(
        await realComplete({
          messages: [
            { role: 'system', content: introPrompt },
            { role: 'user', content: JSON.stringify(introInputs(getCharacter(character.id))) },
          ],
          summary: 'Public bot bio',
          maxTokens: 1400,
        }),
      ).toBe(JSON.stringify(valid))
    } finally {
      fetchSpy.mockRestore()
    }
    const row = accountRow(account.id)
    expect(
      desiredPresence({ ...row, config: { ...row.config, provider: 'onebot11' } }, getCharacter(character.id))[
        'shortDescription:'
      ],
    ).toBeUndefined()
  } finally {
    complete.mockRestore()
    service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
