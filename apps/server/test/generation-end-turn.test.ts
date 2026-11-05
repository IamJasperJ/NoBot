import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CharacterDTO, ChatDTO, PromptPresetDTO } from '@nobot/shared'
import { mockLlm } from './helpers/mockLlm'
import { readSSE } from './helpers/sse'

test('结束回复的工具只请求一次模型，普通工具仍然续写', async () => {
  // 独立进程避免扩展注册表和数据库单例影响其他生成测试。
  if (!process.env.END_TURN_CHILD) {
    const directory = await mkdtemp(join(tmpdir(), 'nobot-end-turn-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        env: { ...process.env, DATA_DIR: directory, END_TURN_CHILD: '1' },
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
  const registry = await import('../src/extensions/registry')
  const { getChatRow, loadPath } = await import('../src/services/chats')
  const model = mockLlm()
  async function json<T>(path: string, data?: unknown, method = 'POST'): Promise<T> {
    const response = await app.request(`/api${path}`, {
      method,
      ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
    })
    const value = await response.json()
    expect(response.status, JSON.stringify(value)).toBe(200)
    return value as T
  }
  registry.registerBuiltinExtension({
    id: 'end-turn-fixture',
    name: '结束回复测试',
    description: '',
    version: '1',
    tools: [true, false].map((endTurn) => ({
      name: endTurn ? 'fixture_end' : 'fixture_continue',
      description: 'Return a spoken line.',
      parameters: { type: 'object', properties: {} },
      run: () => ({ content: 'Finished line', ...(endTurn ? { endTurn: true } : {}) }),
    })),
  })
  await registry.ensureUserExtensions()
  registry.updateExtension('end-turn-fixture', { enabled: true })
  try {
    await json('/connections', { name: 'End turn mock', baseUrl: model.url, model: 'mock-one' })
    const preset = (await json<PromptPresetDTO[]>('/presets', undefined, 'GET'))[0]!
    await json(
      `/presets/${preset.id}`,
      {
        data: { ...preset.data, samplers: { ...preset.data.samplers, functionCalling: true } },
      },
      'PATCH',
    )
    const actor = await json<CharacterDTO>('/characters', { name: 'Assistant' })
    for (const endTurn of [true, false]) {
      const chat = await json<ChatDTO>('/chats', { characterId: actor.id })
      const before = model.requests.length
      const call = { id: 'fixture-call', name: endTurn ? 'fixture_end' : 'fixture_continue', arguments: '{}' }
      model.setScript((body) =>
        body.messages.some((message) => message.role === 'tool') ? { text: 'Continued reply' } : { toolCalls: [call] },
      )
      const response = await app.request(`/api/chats/${chat.id}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'send', text: 'Hello' }),
      })
      const events = await readSSE(response)
      expect(events.some((event) => event.type === 'error')).toBe(false)
      expect(events.at(-1)?.type).toBe('complete')
      expect(model.requests.length - before).toBe(endTurn ? 1 : 2)
      const path = loadPath(getChatRow(chat.id).activeLeafId)
      expect(path.at(-1)).toMatchObject(
        endTurn
          ? { role: 'tool', content: 'Finished line', meta: { toolName: 'fixture_end' } }
          : { role: 'assistant', content: 'Continued reply' },
      )
    }
  } finally {
    await model.stop()
  }
}, 30000)
