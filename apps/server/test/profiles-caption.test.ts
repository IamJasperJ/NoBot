import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage, ProfileDTO, PromptPresetDTO, ResolvedProfileDTO } from '@nobot/shared'
import sharp from 'sharp'

test('配置组优先级、删除、正则、生图连接与图片说明完整流程', async () => {
  if (!process.env.PRF_CAP_CHILD) {
    const directory = await mkdtemp(join(tmpdir(), 'prf-cap-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', 'apps/server/test/profiles-caption.test.ts'], {
        env: { ...process.env, DATA_DIR: directory, PRF_CAP_CHILD: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, out + err).toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    return
  }
  await (await import('../src/bootstrap')).bootstrap()
  const { app } = await import('../src/app')
  const { db, sqlite, setSetting } = await import('../src/db/client')
  const { messages } = await import('../src/db/schema')
  const { createCharacter, updateCharacter, getCharacter } = await import('../src/services/characters')
  const { createChat, getChatRow, updateChat } = await import('../src/services/chats')
  const { createApiPreset } = await import('../src/services/connections')
  const { resolveProfile, selectProfile, profileChatScope } = await import('../src/services/profiles')
  const { updateExtension, runTransform, runAfterPrompt } = await import('../src/extensions/registry')
  const { SETTING_KEYS, setAppSettings } = await import('../src/services/settings')
  const { getAttachment, saveAttachment } = await import('../src/services/attachments')
  const { replaceImageAttachments } = await import('../src/services/caption')
  const { assemble, loadGenerationContext } = await import('../src/services/context')
  const { resolveImageConnection, promptModels } = await import('../src/extensions/builtin/image-gen/discovery')
  const { parseSettings } = await import('../src/extensions/builtin/image-gen/settings')
  const urls: string[] = []
  const requests: Record<string, unknown>[] = []
  let fail = false
  const mocked = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        urls.push(String(_input))
        if (String(_input).endsWith('/models')) return Response.json({ data: [{ id: 'gpt-4o' }] })
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        if (fail) return Response.json({ error: { message: 'mock failure' } }, { status: 500 })
        return Response.json({ choices: [{ message: { content: '一只猫' }, finish_reason: 'stop' }] })
      },
      { preconnect: fetch.preconnect },
    ),
  )
  async function json<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await app.request(`/api${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const value = await response.json()
    expect(response.status, JSON.stringify(value)).toBe(200)
    return value as T
  }
  try {
    const legacy = createApiPreset({ name: '旧连接', baseUrl: 'http://mock/v1', model: 'text', apiKey: 'secret' })
    const vision = createApiPreset({ name: '看图', baseUrl: 'http://vision/v1', model: 'gpt-4o' })
    const character = createCharacter({ name: '角色' })
    const chat = createChat({ characterId: character.id })
    expect(resolveProfile(getChatRow(chat.id)).source).toBe('legacy')
    const { getPromptPreset, updatePromptPreset, createPromptPreset } = await import('../src/services/promptPresets')
    const builtinId = (await import('../src/db/client')).getSetting<string>(SETTING_KEYS.builtinPromptPresetId)!
    const builtinName = getPromptPreset(builtinId).name
    setAppSettings({ language: 'zh' })
    expect((await json<ResolvedProfileDTO>(`/chats/${chat.id}/profile`)).summary.presetName).toBe('默认预设')
    setAppSettings({ language: 'en' })
    expect((await json<ResolvedProfileDTO>(`/chats/${chat.id}/profile`)).summary.presetName).toBe('Default preset')
    updatePromptPreset(builtinId, { name: '自定义内置名' })
    expect(resolveProfile(getChatRow(chat.id)).summary.presetName).toBe('自定义内置名')
    updatePromptPreset(builtinId, { name: builtinName })
    const customPreset = createPromptPreset({ name: '默认预设', data: {} })
    updateChat(chat.id, { promptPresetId: customPreset.id })
    expect(resolveProfile(getChatRow(chat.id)).summary.presetName).toBe('默认预设')
    updateChat(chat.id, { promptPresetId: null })
    setAppSettings({ language: 'zh' })
    const script = { name: '规则', find: 'cat', replace: '猫', input: true, output: true, prompt: true, enabled: true }
    const preset = await json<PromptPresetDTO>('/presets', 'POST', {
      name: '配置组预设',
      data: { samplers: { temperature: 0.25 } },
    })
    const global = await json<ProfileDTO>('/profiles', 'POST', {
      name: '全局',
      promptPresetId: preset.id,
      apiPresetId: vision.id,
      model: 'gpt-5',
      regexScripts: [script],
      image: { source: 'openai', connectionId: vision.id },
      promptConnectionId: vision.id,
    })
    await json('/profiles/default', 'PUT', { id: global.id })
    expect(resolveProfile(getChatRow(chat.id))).toMatchObject({ source: 'global', model: 'gpt-5' })
    expect(resolveProfile(getChatRow(chat.id)).preset.samplers.temperature).toBe(0.25)
    expect(runTransform('transformInput', 'cat', chat.id)).toBe('猫')
    expect(runTransform('transformOutput', 'cat', chat.id)).toBe('猫')
    expect(runAfterPrompt([{ role: 'user', content: 'cat' }], chat.id)[0]?.content).toBe('猫')
    const bound = await json<ProfileDTO>('/profiles', 'POST', {
      name: '角色组',
      apiPresetId: legacy.id,
      regexScripts: [],
    })
    expect(resolveImageConnection(parseSettings({ source: 'openai' }))).toMatchObject({
      openaiBaseUrl: 'http://vision/v1',
      promptConnectionId: vision.id,
    })
    await json(`/profiles/${bound.id}`, 'PUT', {
      ...bound,
      image: { source: 'openai', connectionId: legacy.id },
      promptConnectionId: vision.id,
    })
    updateCharacter(character.id, { profileId: bound.id })
    await profileChatScope.run(chat.id, async () => {
      expect(resolveImageConnection(parseSettings({ source: 'openai' })).openaiBaseUrl).toBe('http://mock/v1')
      expect(
        resolveImageConnection(parseSettings({ source: 'openai', openaiConnectionId: vision.id })).openaiBaseUrl,
      ).toBe('http://mock/v1')
      await promptModels(parseSettings({}), chat.id)
      expect(urls.at(-1)).toBe('http://vision/v1/models')
    })
    await json('/ext/image-gen/openai/models', 'POST', { chatId: chat.id, settings: { openaiConnectionId: '' } })
    expect(urls.at(-1)).toBe('http://mock/v1/models')
    expect(resolveProfile(getChatRow(chat.id)).source).toBe('character')
    expect(runTransform('transformInput', 'cat', chat.id)).toBe('cat')
    expect(selectProfile({ ...getChatRow(chat.id), groupId: 'group' }).source).toBe('global')
    updateChat(chat.id, { profileId: global.id })
    expect(resolveProfile(getChatRow(chat.id)).source).toBe('chat')
    const summary = await json<ResolvedProfileDTO>(`/chats/${chat.id}/profile`)
    expect(summary.connection).not.toHaveProperty('apiKey')
    expect(summary.summary).toMatchObject({
      baseUrl: 'http://vision/v1',
      model: 'gpt-5',
      source: 'chat',
      presetName: '配置组预设',
    })
    await json(`/profiles/${global.id}`, 'PUT', { ...global, model: 'gpt-4.1' })
    expect(loadGenerationContext(chat.id, { requireConnection: true }).connection?.model).toBe('gpt-4.1')
    // 配置组没指定规则时，回到扩展设置里的 enabled 状态。
    updateExtension('regex', { settings: { scripts: [{ ...script, enabled: true }] } })
    await json(`/profiles/${bound.id}`, 'PUT', { name: '角色组', regexScripts: null })
    updateChat(chat.id, { profileId: null })
    expect(runTransform('transformInput', 'cat', chat.id)).toBe('猫')
    updateCharacter(character.id, { profileId: global.id })
    updateChat(chat.id, { profileId: global.id })
    await json(`/profiles/${global.id}`, 'DELETE')
    expect(getChatRow(chat.id).profileId).toBeNull()
    expect(getCharacter(character.id).profileId).toBeNull()
    expect(resolveProfile(getChatRow(chat.id)).source).toBe('legacy')
    expect(resolveProfile(getChatRow(chat.id)).connection?.id).toBe(legacy.id)

    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } })
      .png()
      .toBuffer()
    const attachment = await saveAttachment(png)
    const prompt: ChatMessage[] = [{ role: 'user', content: '看这里', images: [attachment.id] }]
    expect(replaceImageAttachments(prompt, resolveProfile(getChatRow(chat.id)).connection)[0]?.content).toContain(
      '[Image]',
    )
    updateChat(chat.id, { apiPresetId: vision.id })
    expect(replaceImageAttachments(prompt, resolveProfile(getChatRow(chat.id)).connection)).toEqual(prompt)
    updateExtension('caption', { enabled: true, settings: { alwaysText: true } })
    setAppSettings({ language: 'en' })
    const described = await json<{ caption: string }>(`/ext/caption/attachments/${attachment.id}`, 'POST', {
      chatId: chat.id,
    })
    expect(described.caption).toBe('一只猫')
    expect(getAttachment(attachment.id).caption).toBe('一只猫')
    expect(JSON.stringify(requests.at(-1))).toContain('Write in English.')
    expect(JSON.stringify(requests.at(-1))).toContain('image_url')
    expect(replaceImageAttachments(prompt, resolveProfile(getChatRow(chat.id)).connection)[0]).toEqual({
      role: 'user',
      content: '看这里\n[Image: 一只猫]',
    })
    const id = 'caption-message'
    db.insert(messages)
      .values({
        id,
        chatId: chat.id,
        role: 'user',
        content: '',
        meta: { images: [getAttachment(attachment.id)] },
        createdAt: 1,
      })
      .run()
    updateChat(chat.id, {})
    const ctx = loadGenerationContext(chat.id, { requireConnection: true })
    const built = assemble(ctx, { type: 'normal', speakerId: character.id, leafId: id })
    expect(built.messages.some((message) => message.content.includes('[Image: 一只猫]'))).toBe(true)
    expect(built.messages.flatMap((message) => message.images ?? [])).toEqual([])
    fail = true
    const failed = await json<{ caption: string }>(`/ext/caption/attachments/${attachment.id}`, 'POST', {
      chatId: chat.id,
    })
    expect(failed.caption).toBe('一只猫')
    const form = new FormData()
    form.append('file', new File([png], 'cat.png'))
    form.append('chatId', chat.id)
    const uploaded = await app.request('/api/attachments', { method: 'POST', body: form })
    expect(uploaded.status).toBe(200)
    expect(await uploaded.json()).not.toHaveProperty('caption')
    fail = false
    const okForm = new FormData()
    okForm.append('file', new File([png], 'cat.png'))
    okForm.append('chatId', chat.id)
    const okUpload = await app.request('/api/attachments', { method: 'POST', body: okForm })
    expect(await okUpload.json()).toHaveProperty('caption', '一只猫')
    updateExtension('caption', { enabled: false })
    expect(
      (await app.request(`/api/ext/caption/attachments/${attachment.id}`, { method: 'POST', body: '{}' })).status,
    ).toBe(404)
    setSetting(SETTING_KEYS.defaultProfileId, null)
  } finally {
    mocked.mockRestore()
    sqlite.close()
  }
}, 15000)
