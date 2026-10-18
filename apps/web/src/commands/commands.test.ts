import { afterEach, describe, expect, test } from 'bun:test'
import type { ChatPage } from '@ai-parter/shared'
import { api } from '../api/client'
import { registerBuiltins } from './builtins'
import { parseCommandLine } from './parser'
import { getCommand, listCommands, registerCommand, searchCommands } from './registry'
import { type CommandContext, runCommandLine } from './run'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})
const context = (overrides: Partial<CommandContext> = {}): CommandContext => ({
  chatId: 'chat',
  api,
  generate: async () => {},
  refresh: async () => {},
  getInput: () => '',
  setInput: () => {},
  notify: () => {},
  prompt: async () => 'answer',
  getActiveSets: async () => [],
  ...overrides,
})

describe('命令解析', () => {
  test('命名参数、两种引号、空值和自由文本', () => {
    expect(parseCommandLine(`/test key="带空格 的值" other='hello world' empty="" 自由 文本`)).toEqual([
      { name: 'test', args: { key: '带空格 的值', other: 'hello world', empty: '' }, text: '自由 文本' },
    ])
  })
  test('转义管道、引号和反斜杠；引号里的管道不分段', () => {
    const result = parseCommandLine(String.raw`/test "a|b" 'c|d' e\|f "g\"h" C:\temp \\ | /next {{pipe}}`)
    expect(result).toEqual([
      { name: 'test', args: {}, text: 'a|b c|d e|f g"h C:\\temp \\' },
      { name: 'next', args: {}, text: '{{pipe}}' },
    ])
  })
  test('自由文本保留换行和空格', () => {
    expect(parseCommandLine('/send first  line\nsecond line')[0]?.text).toBe('first  line\nsecond line')
  })
  test('被引号和转义保护的等号保持自由文本', () => {
    expect(parseCommandLine(String.raw`/echo "x=y" x\=z`)[0]?.text).toBe('x=y x=z')
  })
  test('大小写归一化、空白和危险键按普通参数处理', () => {
    const result = parseCommandLine('  /TEST __proto__=value\ntext  ')
    expect(result[0]?.name).toBe('test')
    expect(Object.getOwnPropertyDescriptor(result[0]!.args, '__proto__')?.value).toBe('value')
    expect(result[0]?.text).toBe('text')
  })
  test.each(['/echo "x', '/echo a |', '| /echo x', 'hello', '/'])('拒绝无效语法：%s', (source) => {
    expect(() => parseCommandLine(source)).toThrow()
  })
})

describe('注册和执行', () => {
  test('按别名查找、前缀搜索和注销；禁止覆盖已有命令', () => {
    const command = { name: 'test-search', aliases: ['test-alias'], description: 'test', args: [], run: async () => '' }
    const dispose = registerCommand(command)
    cleanup.push(dispose)
    expect(getCommand('TEST-ALIAS')).toBe(command)
    expect(searchCommands('/test-a').map((s) => s.name)).toEqual(['test-alias'])
    expect(listCommands().find((s) => s.name === 'test-search')?.args).toEqual([])
    expect(() => registerCommand({ ...command, name: 'another' })).toThrow()
    dispose()
    expect(getCommand('test-alias')).toBeUndefined()
  })
  test('隐式管道、显式宏、命名参数宏、空返回值及注入隔离', async () => {
    cleanup.push(registerCommand({ name: 'test-source', description: '', args: [], run: async () => 'a | /evil' }))
    cleanup.push(
      registerCommand({
        name: 'test-target',
        description: '',
        args: [],
        run: async (_ctx, args, text) => args.value ?? text,
      }),
    )
    expect(await runCommandLine('/test-source | /test-target', context())).toBe('a | /evil')
    expect(await runCommandLine('/test-source | /test-target prefix {{pipe}} suffix', context())).toBe(
      'prefix a | /evil suffix',
    )
    expect(await runCommandLine('/test-source | /test-target value={{pipe}}', context())).toBe('a | /evil')
  })
  test('错误附带命令名并停止管道', async () => {
    let called = false
    cleanup.push(
      registerCommand({
        name: 'test-after',
        description: '',
        args: [],
        run: async () => {
          called = true
        },
      }),
    )
    await expect(runCommandLine('/missing-command | /test-after', context())).rejects.toThrow('/missing-command:')
    expect(called).toBe(false)
  })
  test('参数验证和递归限制', async () => {
    cleanup.push(
      registerCommand({
        name: 'test-required',
        description: '',
        args: [{ name: 'n', type: 'number', required: true, description: '' }],
        run: async () => '',
      }),
    )
    await expect(runCommandLine('/test-required', context())).rejects.toThrow('n')
    await expect(runCommandLine('/test-required n=abc', context())).rejects.toThrow('n')
    await expect(runCommandLine('/test-required n=1', context({ depth: 16 }))).rejects.toThrow()
  })
  test('内置命令调用 API：发消息不生成、变量、模型、旁白和输入', async () => {
    registerBuiltins()
    const messages: unknown[] = []
    let generated = false
    const ctx = context({
      api: {
        ...api,
        appendMessage: async (...args) => {
          messages.push(args)
          return {} as Awaited<ReturnType<typeof api.appendMessage>>
        },
        setVars: async (_id, set) => {
          expect(set).toEqual({ hp: 3 })
          return { vars: set }
        },
        getChatPage: async () => ({ vars: { hp: 3 } }) as unknown as ChatPage,
        getChatProfile: async () => ({ model: 'test-model' }) as Awaited<ReturnType<typeof api.getChatProfile>>,
      },
      generate: async () => {
        generated = true
      },
    })
    expect(await runCommandLine('/send hello | /sys {{pipe}}', ctx)).toBe('hello')
    expect(messages).toEqual([
      ['chat', 'user', 'hello'],
      ['chat', 'system', 'hello'],
    ])
    expect(generated).toBe(false)
    expect(await runCommandLine('/setvar name=hp 3', ctx)).toBe('3')
    expect(await runCommandLine('/getvar hp', ctx)).toBe('3')
    expect(await runCommandLine('/model', ctx)).toBe('test-model')
    expect(await runCommandLine('/input prompt', ctx)).toBe('answer')
    await expect(runCommandLine('/delay -1', ctx)).rejects.toThrow('/delay:')
  })
})
