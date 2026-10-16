import { afterAll, beforeAll, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CharacterDTO,
  ChatDTO,
  ChatPage,
  GenerateEvent,
  GenerateInput,
  GenerationLogDTO,
  GenerationLogSummary,
  GroupDTO,
  LorebookDTO,
  LorebookEntryDTO,
  MessageDTO,
  PresetData,
  PromptPresetDTO,
  PromptPreview,
} from '@ai-parter/shared'
import { isolatedTest as test } from './helpers/isolated'
import { mockLlm } from './helpers/mockLlm'
import { readSSE, waitFor } from './helpers/sse'

let app: typeof import('../src/app').app
let sqlite: typeof import('../src/db/client').sqlite
let directory: string
let model: ReturnType<typeof mockLlm>
let preset: PromptPresetDTO
const previousDataDir = process.env.DATA_DIR
const activeReads: Promise<GenerateEvent[]>[] = []
const chatIds: string[] = []

beforeAll(async () => {
  if (!process.env.GENERATION_TEST_CASE) return
  directory = await mkdtemp(join(tmpdir(), 'ai-parter-generation-'))
  process.env.DATA_DIR = directory
  await (await import('../src/bootstrap')).bootstrap()
  sqlite = (await import('../src/db/client')).sqlite
  app = (await import('../src/app')).app
  model = mockLlm()
  preset = (await json<PromptPresetDTO[]>('/presets'))[0]!
})

afterAll(async () => {
  if (!process.env.GENERATION_TEST_CASE) return
  try {
    // 断言失败也必须先结束后台任务，避免任务还在写已经关闭的数据库。
    for (const id of chatIds) await request(`/chats/${id}/abort`, 'POST')
    await Promise.allSettled(activeReads)
  } finally {
    await model?.stop()
    sqlite?.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    if (directory) await rm(directory, { recursive: true, force: true })
  }
})

function request(path: string, method = 'GET', data?: unknown) {
  return app.request(`/api${path}`, {
    method,
    ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  })
}
async function json<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await request(path, method, data)
  const value: unknown = await response.json()
  expect(response.status, JSON.stringify(value)).toBe(200)
  return value as T
}
async function character(name = '守林人') {
  return json<CharacterDTO>('/characters', 'POST', {
    name,
    description: '守护月光森林的旅伴',
    first_mes: '欢迎来到森林',
  })
}
async function createChat(input: { characterId: string } | { groupId: string }) {
  const chat = await json<ChatDTO>('/chats', 'POST', input)
  chatIds.push(chat.id)
  return chat
}
async function setup(connection = true) {
  if (connection) await json('/connections', 'POST', { name: '模拟连接', baseUrl: model.url, model: 'mock-one' })
  const actor = await character()
  const chat = await createChat({ characterId: actor.id })
  return { chat, actor }
}
const page = (chat: ChatDTO) => json<ChatPage>(`/chats/${chat.id}`)
const logs = (chat: ChatDTO) => json<GenerationLogSummary[]>(`/logs?chatId=${chat.id}`)
async function generate(chat: ChatDTO, input: GenerateInput = { mode: 'send', text: '你好' }) {
  const response = await request(`/chats/${chat.id}/generate`, 'POST', input)
  const read = readSSE(response)
  activeReads.push(read)
  return read
}
function done(events: GenerateEvent[]) {
  return events.filter((e): e is Extract<GenerateEvent, { type: 'done' }> => e.type === 'done').map((e) => e.message)
}
function text(events: GenerateEvent[]) {
  return events
    .filter((e) => e.type === 'delta')
    .map((e) => e.text)
    .join('')
}
function last(messages: MessageDTO[]) {
  return messages.at(-1)!
}
async function updatePreset(update: (data: PresetData) => PresetData) {
  preset = await json<PromptPresetDTO>(`/presets/${preset.id}`, 'PATCH', { data: update(preset.data) })
}
async function live(chat: ChatDTO, content = '这是用于验证流式中止和重连的完整模拟回复文本') {
  model.setScript(() => ({ text: content, delayMs: 25 }))
  const observed: GenerateEvent[] = []
  const response = await request(`/chats/${chat.id}/generate`, 'POST', { mode: 'send', text: '慢慢说' })
  const reading = readSSE(response, (event) => observed.push(event))
  activeReads.push(reading)
  await waitFor(() => text(observed).length >= 2)
  return { observed, reading, content }
}

test('单人发送按顺序推送事件并保存完整路径和角色提示词', async () => {
  const { chat } = await setup()
  const models = await json<{ ok: boolean; models: string[] }>('/connections/test', 'POST', { baseUrl: model.url })
  expect(models).toMatchObject({ ok: true, models: ['mock-one', 'mock-two'] })
  model.setScript(() => ({ text: '月光照亮前路' }))
  const events = await generate(chat)
  expect(events[0]).toMatchObject({ type: 'start', userMessage: { role: 'user', content: '你好' } })
  expect(events.slice(1, -2).length).toBeGreaterThan(1)
  expect(events.slice(1, -2).every((e) => e.type === 'delta')).toBe(true)
  expect(events.slice(-2).map((e) => e.type)).toEqual(['done', 'complete'])
  expect(done(events)[0]?.content).toBe('月光照亮前路')
  expect((await page(chat)).messages.map((m) => m.content)).toEqual(['欢迎来到森林', '你好', '月光照亮前路'])
  expect(model.requests[0]?.messages[0]?.role).toBe('system')
  expect(model.requests[0]?.messages[0]?.content).toContain('守护月光森林的旅伴')
})

test('推理分片被合并到最终消息的元数据', async () => {
  const { chat } = await setup()
  model.setScript(() => ({ text: '回答', reasoning: '先观察再思考' }))
  const events = await generate(chat)
  expect(
    events
      .filter((e) => e.type === 'delta')
      .map((e) => e.reasoning ?? '')
      .join(''),
  ).toBe('先观察再思考')
  expect(done(events)[0]?.meta.reasoning).toBe('先观察再思考')
  expect(last((await page(chat)).messages).meta.reasoning).toBe('先观察再思考')
})

test('重新生成产生兄弟节点并可左右切换激活路径', async () => {
  const { chat } = await setup()
  model.setScript(() => ({ text: '第一版' }))
  const first = done(await generate(chat))[0]!
  model.setScript(() => ({ text: '第二版' }))
  const second = done(await generate(chat, { mode: 'regenerate', targetId: first.id }))[0]!
  expect(second).toMatchObject({ parentId: first.parentId, swipeIndex: 2, swipeCount: 2, content: '第二版' })
  expect(second.id).not.toBe(first.id)
  await json(`/chats/${chat.id}/swipe`, 'POST', { messageId: second.id, direction: -1 })
  expect(last((await page(chat)).messages)).toMatchObject({ id: first.id, content: '第一版', swipeCount: 2 })
  await json(`/chats/${chat.id}/swipe`, 'POST', { messageId: first.id, direction: 1 })
  expect(last((await page(chat)).messages).id).toBe(second.id)
})

test('续写拼接预设后缀且上游失败时保留原文与完成状态', async () => {
  const { chat } = await setup()
  await updatePreset((data) => ({ ...data, behavior: { ...data.behavior, continuePostfix: '\n\n' } }))
  model.setScript(() => ({ text: '原文' }))
  const original = done(await generate(chat))[0]!
  model.setScript(() => ({ text: '后文' }))
  const continued = done(await generate(chat, { mode: 'continue', targetId: original.id }))[0]!
  expect(continued).toMatchObject({ id: original.id, content: '原文\n\n后文', status: 'done' })
  model.setScript(() => ({ status: 500, error: '服务暂时失败' }))
  const failed = await generate(chat, { mode: 'continue', targetId: original.id })
  expect(failed.some((e) => e.type === 'error')).toBe(true)
  expect(last((await page(chat)).messages)).toMatchObject({
    id: original.id,
    content: continued.content,
    status: 'done',
  })
})

test('中止生成保留已经收到的部分文本并标记中止', async () => {
  const { chat } = await setup()
  const { reading, observed, content } = await live(chat)
  const before = text(observed)
  await json(`/chats/${chat.id}/abort`, 'POST')
  const events = await reading
  const message = last((await page(chat)).messages)
  expect(message.status).toBe('aborted')
  expect(message.content.startsWith(before)).toBe(true)
  expect(message.content.length).toBeGreaterThan(0)
  expect(message.content.length).toBeLessThan(content.length)
  expect(message.content).toBe(text(events))
  expect(events.at(-1)?.type).toBe('complete')
})

test('重新连接先回放开始和已有文本再接收剩余分片', async () => {
  const { chat } = await setup()
  const { reading, content } = await live(chat)
  const response = await request(`/chats/${chat.id}/stream`)
  const reconnect = readSSE(response)
  activeReads.push(reconnect)
  const events = await reconnect
  const start = events[0]
  expect(start?.type).toBe('start')
  if (start?.type !== 'start') throw new Error('重连缺少开始事件')
  expect(events[1]?.type).toBe('delta')
  if (events[1]?.type === 'delta') expect(events[1].text.length).toBeGreaterThanOrEqual(2)
  expect(start.assistantMessage.content + text(events)).toBe(content)
  expect(done(events)[0]?.content).toBe(content)
  expect(events.at(-1)?.type).toBe('complete')
  expect(text(await reading)).toBe(content)
})

test('上游鉴权错误推送中文提示并保存错误消息和日志', async () => {
  const { chat } = await setup()
  model.setScript(() => ({ status: 401, error: 'invalid key' }))
  const events = await generate(chat)
  const error = events.find((e) => e.type === 'error')
  expect(error).toMatchObject({ type: 'error', code: 'HTTP_401' })
  if (error?.type === 'error') expect(error.message).toMatch(/[\u4e00-\u9fff]/)
  expect(last((await page(chat)).messages).status).toBe('error')
  expect(await logs(chat)).toHaveLength(1)
  expect((await logs(chat))[0]?.status).toBe('error')
  expect(events.at(-1)?.type).toBe('complete')
})

test('缺少连接时返回配置错误且不会插入任何消息', async () => {
  const { chat } = await setup(false)
  const before = await page(chat)
  const response = await request(`/chats/${chat.id}/generate`, 'POST', { mode: 'send', text: '不应保存' })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: { code: 'NO_API_PRESET' } })
  expect(await page(chat)).toEqual(before)
  expect(model.requests).toHaveLength(0)
})

async function toolRound(chat: ChatDTO, name = 'roll_dice', args = '{"expression":"2d6+3"}') {
  const offset = model.requests.length
  const call = { id: `call_test_${offset}`, name, arguments: args }
  model.setScript((body) =>
    body.messages.some((message) => message.role === 'tool' && message.tool_call_id === call.id)
      ? { text: '工具执行完成' }
      : { toolCalls: [call] },
  )
  const events = await generate(chat)
  return { events, call, requests: model.requests.slice(offset) }
}

test('工具分片拼接执行回传且状态随消息路径累加和回退', async () => {
  const { chat } = await setup()
  await updatePreset((data) => ({ ...data, samplers: { ...data.samplers, functionCalling: true } }))
  const { events, call, requests } = await toolRound(chat)
  expect(done(events)).toHaveLength(2)
  expect(events.filter((e) => e.type === 'message')).toHaveLength(1)
  expect((await page(chat)).messages.slice(1).map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
  expect(done(events)[0]?.meta.toolCalls).toEqual([call])
  const tool = (await page(chat)).messages.find((m) => m.role === 'tool')!
  expect(tool.meta).toMatchObject({ toolCallId: call.id, toolName: 'roll_dice' })
  expect(tool.content).toContain('2d6+3')
  expect(requests).toHaveLength(2)
  expect(requests.every((body) => Array.isArray(body.tools) && body.tools.length > 0)).toBe(true)
  expect(requests[1]?.messages.find((m) => m.tool_calls)?.tool_calls).toEqual([
    { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } },
  ])
  expect(requests[1]?.messages).toContainEqual(
    expect.objectContaining({ role: 'tool', tool_call_id: call.id, content: tool.content }),
  )
  const stateRound = await toolRound(chat, 'set_chat_state', '{"key":"旅人.HP","value":17}')
  expect((await page(chat)).vars).toEqual({ '旅人.HP': 17 })
  model.setScript(() => ({ text: '重新解释状态' }))
  await generate(chat, { mode: 'regenerate', targetId: done(stateRound.events)[1]!.id })
  expect((await page(chat)).vars).toEqual({ '旅人.HP': 17 })
  const stateTool = (await page(chat)).messages.find((m) => m.meta.toolName === 'set_chat_state')!
  await json(`/messages/${stateTool.id}`, 'DELETE')
  expect((await page(chat)).vars).toEqual({})
})

test('关闭工具调用后历史工具信息转为文字且不发送工具字段', async () => {
  const { chat } = await setup()
  await updatePreset((data) => ({ ...data, samplers: { ...data.samplers, functionCalling: true } }))
  await toolRound(chat)
  const tool = (await page(chat)).messages.find((m) => m.role === 'tool')!
  await updatePreset((data) => ({ ...data, samplers: { ...data.samplers, functionCalling: false } }))
  model.setScript(() => ({ text: '普通回复' }))
  await generate(chat)
  const body = model.requests.at(-1)!
  expect(body).not.toHaveProperty('tools')
  expect(body.messages.some((m) => m.role === 'tool' || m.tool_calls !== undefined)).toBe(false)
  const history = body.messages.map((m) => m.content).join('\n')
  expect(history).toContain('roll_dice')
  expect(history).toContain(tool.content)
})

test('群聊依次发言支持指定成员且手动模式仅保存用户消息', async () => {
  await json('/connections', 'POST', { name: '模拟连接', baseUrl: model.url, model: 'mock-one' })
  const a = await character('成员甲')
  const b = await character('成员乙')
  const group = await json<GroupDTO>('/groups', 'POST', {
    name: '队伍',
    activation: 'list',
    members: [{ characterId: a.id }, { characterId: b.id }],
  })
  const chat = await createChat({ groupId: group.id })
  const events = await generate(chat)
  expect(done(events).map((m) => m.speakerId)).toEqual([a.id, b.id])
  expect(done(events).map((m) => m.meta.name)).toEqual([a.name, b.name])
  expect(model.requests.at(-1)?.messages.at(-1)?.content).toContain(b.name)
  expect(done(await generate(chat, { mode: 'trigger', speakerId: a.id })).map((m) => m.speakerId)).toEqual([a.id])
  await json(`/groups/${group.id}`, 'PATCH', { activation: 'manual' })
  const before = (await page(chat)).messages.length
  const count = model.requests.length
  const manual = await generate(chat, { mode: 'send', text: '手动模式消息' })
  expect(manual.map((e) => e.type)).toEqual(['message', 'complete'])
  expect((await page(chat)).messages).toHaveLength(before + 1)
  expect(last((await page(chat)).messages)).toMatchObject({ role: 'user', content: '手动模式消息' })
  expect(model.requests).toHaveLength(count)
})

test('代写只推送文本和完成事件不新增消息并记录代写日志', async () => {
  const { chat } = await setup()
  const before = await page(chat)
  model.setScript(() => ({ text: '我走进了森林' }))
  const events = await readSSE(await request(`/chats/${chat.id}/impersonate`, 'POST'))
  expect(text(events)).toBe('我走进了森林')
  expect(events.at(-1)?.type).toBe('complete')
  expect(events.slice(0, -1).every((e) => e.type === 'delta')).toBe(true)
  expect(await page(chat)).toEqual(before)
  expect(await logs(chat)).toEqual([expect.objectContaining({ kind: 'impersonate', status: 'ok' })])
})

test('分支复制选中路径到新会话并保持原会话不变', async () => {
  const { chat } = await setup()
  await generate(chat)
  const original = await page(chat)
  const branch = await json<ChatDTO>(`/chats/${chat.id}/branch`, 'POST', { messageId: last(original.messages).id })
  chatIds.push(branch.id)
  const copied = await page(branch)
  expect(branch.id).not.toBe(chat.id)
  expect(copied.messages.map((m) => m.content)).toEqual(original.messages.map((m) => m.content))
  expect(copied.messages.map((m) => m.role)).toEqual(original.messages.map((m) => m.role))
  expect(copied.messages.every((m) => m.chatId === branch.id && !original.messages.some((o) => o.id === m.id))).toBe(
    true,
  )
  expect(await page(chat)).toEqual(original)
})

test('全局世界书关键词在预览报告和实际模型请求中激活', async () => {
  const { chat } = await setup()
  const book = await json<LorebookDTO>('/lorebooks', 'POST', { name: '森林设定', isGlobal: true })
  const entry = await json<LorebookEntryDTO>(`/lorebooks/${book.id}/entries`, 'POST', {
    keys: ['银月石'],
    content: '银月石能够照亮隐秘道路',
  })
  const preview = await json<PromptPreview>(`/chats/${chat.id}/prompt-preview`, 'POST', { text: '寻找银月石' })
  expect(preview.report.worldInfo).toContainEqual(expect.objectContaining({ entryId: entry.id, activated: true }))
  expect(preview.report.segments.some((segment) => segment.content.includes(entry.content))).toBe(true)
  await generate(chat, { mode: 'send', text: '寻找银月石' })
  expect(model.requests[0]?.messages.some((m) => m.content.includes(entry.content))).toBe(true)
})

test('正则扩展分别转换保存的用户输入和模型输出', async () => {
  const { chat } = await setup()
  expect(await json<{ id: string }[]>('/extensions')).toContainEqual(expect.objectContaining({ id: 'regex' }))
  await json('/extensions/regex', 'PATCH', {
    enabled: true,
    settings: {
      scripts: [
        { name: '输出替换', find: '模拟', replace: '测试', input: false, output: true, prompt: false, enabled: true },
        { name: '输入替换', find: '原始', replace: '处理后', input: true, output: false, prompt: false, enabled: true },
      ],
    },
  })
  model.setScript(() => ({ text: '模拟回复' }))
  const events = await generate(chat, { mode: 'send', text: '原始消息' })
  expect(done(events)[0]?.content).toBe('测试回复')
  expect((await page(chat)).messages.slice(-2).map((m) => m.content)).toEqual(['处理后消息', '测试回复'])
  expect(model.requests[0]?.messages).toContainEqual(expect.objectContaining({ role: 'user', content: '处理后消息' }))
})

test('日志倒序保存请求响应报告并由消息引用且支持全部清空', async () => {
  const { chat } = await setup()
  await generate(chat)
  await generate(chat, { mode: 'send', text: '第二轮' })
  const list = await json<GenerationLogSummary[]>('/logs')
  expect(list).toHaveLength(2)
  expect(list.map((log) => log.createdAt)).toEqual(list.map((log) => log.createdAt).sort((a, b) => b - a))
  const messages = (await page(chat)).messages.filter((m) => m.meta.logId)
  // 同一毫秒内的日志允许任意先后，倒序只约束时间，关联关系单独验证。
  expect(list.map((log) => log.id).sort()).toEqual(messages.map((m) => m.meta.logId!).sort())
  for (const message of messages) {
    const log = await json<GenerationLogDTO>(`/logs/${message.meta.logId}`)
    expect(log.messageId).toBe(message.id)
    expect(log.request).toMatchObject({ messages: expect.any(Array) })
    expect(log.response).toMatchObject({ content: message.content })
    expect(log.report).toMatchObject({ segments: expect.any(Array), totalTokens: expect.any(Number) })
  }
  await json('/logs', 'DELETE')
  expect(await json('/logs')).toEqual([])
})

test('同一会话正在生成时拒绝并发请求且不插入额外消息', async () => {
  const { chat } = await setup()
  const { reading } = await live(chat)
  const before = (await page(chat)).messages.map((m) => m.id)
  const response = await request(`/chats/${chat.id}/generate`, 'POST', { mode: 'send', text: '重复发送' })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: { code: 'BUSY' } })
  expect((await page(chat)).messages.map((m) => m.id)).toEqual(before)
  expect(model.requests).toHaveLength(1)
  await json(`/chats/${chat.id}/abort`, 'POST')
  await reading
})

test('预设采样参数和额外请求体正确透传且非流式响应正常完成', async () => {
  const { chat } = await setup()
  await updatePreset((data) => ({
    ...data,
    samplers: {
      ...data.samplers,
      temperature: 0.3,
      topK: 40,
      seed: 7,
      stream: false,
      extraBody: '{"foo":1}',
    },
  }))
  model.setScript(() => ({ text: '非流式回复', reasoning: '非流式推理' }))
  const events = await generate(chat)
  expect(model.requests[0]).toMatchObject({ temperature: 0.3, top_k: 40, seed: 7, stream: false, foo: 1 })
  expect(model.requests[0]).not.toHaveProperty('stream_options')
  expect(done(events)[0]).toMatchObject({ content: '非流式回复', status: 'done', meta: { reasoning: '非流式推理' } })
  expect(text(events)).toBe('非流式回复')
  expect(events.at(-1)?.type).toBe('complete')
})
