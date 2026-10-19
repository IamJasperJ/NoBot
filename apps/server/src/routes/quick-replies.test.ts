import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CharacterDTO, ChatDTO, ChatPage, PromptPreview, QuickReplySet, QuickReplyState } from '@ai-parter/shared'

test('快速回复 API、作用域持久化、追加消息、骰子和扩展命令生命周期', async () => {
  // 数据库模块单例需要在子进程里设置临时目录，避免污染其他集成测试。
  if (!process.env.QUICK_REPLY_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, QUICK_REPLY_TEST_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timeout = setTimeout(() => child.kill(), 25000)
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, `${out}\n${err}`).toBe(0)
    } finally {
      clearTimeout(timeout)
    }
    return
  }
  const directory = await mkdtemp(join(tmpdir(), 'ai-parter-quick-reply-'))
  process.env.DATA_DIR = directory
  const { bootstrap } = await import('../bootstrap')
  const { sqlite } = await import('../db/client')
  try {
    await bootstrap()
    const { app } = await import('../app')
    const request = async (method: string, path: string, body?: unknown) =>
      app.request(`/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    const set = (await (
      await request('POST', '/quick-replies', {
        name: 'set',
        buttons: [{ id: 'qr', label: 'Hi', message: '/echo hello' }],
      })
    ).json()) as QuickReplySet
    expect(set.buttons[0]?.autoExecute.onAi).toBe(false)
    expect((await request('POST', '/quick-replies', { name: 'set', buttons: [] })).status).toBe(409)
    expect((await request('POST', '/quick-replies', { name: 'bad', buttons: [{ id: 'x', label: '' }] })).status).toBe(
      400,
    )
    const state = (await (
      await request('PUT', '/quick-replies/global', { setIds: [set.id, set.id] })
    ).json()) as QuickReplyState
    expect(state.setIds).toEqual([set.id])
    const character = (await (await request('POST', '/characters', { name: 'Test' })).json()) as CharacterDTO
    const patched = (await (
      await request('PATCH', `/characters/${character.id}`, { quickReplySetIds: [set.id] })
    ).json()) as CharacterDTO
    expect(patched.quickReplySetIds).toEqual([set.id])
    const chat = (await (await request('POST', '/chats', { characterId: character.id })).json()) as ChatDTO
    const chatPatch = (await (
      await request('PATCH', `/chats/${chat.id}`, { quickReplySetIds: [set.id] })
    ).json()) as ChatDTO
    expect(chatPatch.quickReplySetIds).toEqual([set.id])
    expect((await request('PATCH', `/chats/${chat.id}`, { quickReplySetIds: ['missing'] })).status).toBe(404)
    await request('POST', `/chats/${chat.id}/messages`, { role: 'user', content: 'hello' })
    await request('POST', `/chats/${chat.id}/messages`, { role: 'system', content: 'narration' })
    expect((await request('POST', `/chats/${chat.id}/messages`, { role: 'assistant', content: 'bad' })).status).toBe(
      400,
    )
    const page = (await (await request('GET', `/chats/${chat.id}`)).json()) as ChatPage
    expect(page.chat.quickReplySetIds).toEqual([set.id])
    expect(page.messages.slice(-2).map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello'],
      ['system', 'narration'],
    ])
    expect((await request('POST', `/chats/${chat.id}/roll`, { expression: 'bad' })).status).toBe(400)
    const roll = (await (await request('POST', `/chats/${chat.id}/roll`, { expression: '2d2dl2+5' })).json()) as {
      result: string
    }
    expect(roll).toEqual({ result: '2d2dl2+5 = 5' })
    const preview = (await (await request('POST', `/chats/${chat.id}/prompt-preview`, {})).json()) as PromptPreview
    const rollSegment = preview.report.segments.find((segment) => segment.content === roll.result)!
    expect(rollSegment).toMatchObject({ source: 'history', role: 'system', content: roll.result })
    expect(preview.messages.find((message) => message.content.includes(roll.result))).toMatchObject({ role: 'system' })
    expect(
      preview.messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .some((message) => message.content.includes(roll.result)),
    ).toBe(false)

    const { registerBuiltinExtension, updateExtension, listExtensions } = await import('../extensions/registry')
    const { setAppSettings } = await import('../services/settings')
    setAppSettings({ language: 'en' })
    expect(listExtensions().find((e) => e.id === 'image-gen')?.commands?.[0]?.description).toBe('Generate an image')
    setAppSettings({ language: 'zh' })
    expect(
      (
        await request('POST', '/ext/image-gen/commands/imagine', {
          chatId: chat.id,
          args: { mode: 'invalid' },
          text: '',
        })
      ).status,
    ).toBe(400)
    registerBuiltinExtension({
      id: 'test-commands',
      name: 'Test',
      description: '',
      version: '1',
      enabledByDefault: true,
      commands: [
        {
          name: 'test-server',
          description: '',
          args: [{ name: 'value', type: 'string', required: true, description: '' }],
          run: async (ctx, args, text) => `${ctx.chatId}:${args.value}:${text}`,
        },
      ],
    })
    const result = await (
      await request('POST', '/ext/test-commands/commands/test-server', {
        chatId: chat.id,
        args: { value: 'x' },
        text: 'hello',
      })
    ).json()
    expect(result).toEqual({ result: `${chat.id}:x:hello` })
    expect((await request('POST', '/ext/test-commands/commands/test-server', { args: {}, text: '' })).status).toBe(400)
    updateExtension('test-commands', { enabled: false })
    expect((await request('POST', '/ext/test-commands/commands/test-server', { args: {}, text: '' })).status).toBe(404)
    expect((await request('PUT', `/quick-replies/${set.id}`, { name: 'renamed', buttons: [] })).status).toBe(200)
    const retained = (await (
      await request('POST', '/quick-replies', { name: 'retained', buttons: [] })
    ).json()) as QuickReplySet
    const otherCharacter = (await (await request('POST', '/characters', { name: 'Other' })).json()) as CharacterDTO
    const otherChat = (await (await request('POST', '/chats', { characterId: otherCharacter.id })).json()) as ChatDTO
    await request('PUT', '/quick-replies/global', { setIds: [set.id, retained.id] })
    await request('PATCH', `/characters/${character.id}`, { quickReplySetIds: [set.id, retained.id] })
    await request('PATCH', `/chats/${chat.id}`, { quickReplySetIds: [retained.id, set.id] })
    await request('PATCH', `/characters/${otherCharacter.id}`, { quickReplySetIds: [set.id] })
    await request('PATCH', `/chats/${otherChat.id}`, { quickReplySetIds: [set.id] })
    expect((await request('DELETE', `/quick-replies/${set.id}`)).status).toBe(200)
    const remaining = (await (await request('GET', '/quick-replies')).json()) as QuickReplyState
    expect(remaining.sets.map((item) => item.id)).toEqual([retained.id])
    expect(remaining.setIds).toEqual([retained.id])
    for (const [id, expected] of [
      [chat.id, [retained.id]],
      [otherChat.id, []],
    ] as const) {
      const result = (await (await request('GET', `/chats/${id}`)).json()) as ChatPage
      expect(result.chat.quickReplySetIds).toEqual([...expected])
    }
    for (const [id, expected] of [
      [character.id, [retained.id]],
      [otherCharacter.id, []],
    ] as const) {
      const result = (await (await request('GET', `/characters/${id}`)).json()) as CharacterDTO
      expect(result.quickReplySetIds ?? []).toEqual([...expected])
    }
    expect((await request('DELETE', `/quick-replies/${set.id}`)).status).toBe(404)
    expect((await request('DELETE', `/quick-replies/${retained.id}`)).status).toBe(200)
    const empty = (await (await request('GET', '/quick-replies')).json()) as QuickReplyState
    expect(empty).toEqual({ sets: [], setIds: [] })
  } finally {
    sqlite.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
