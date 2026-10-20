import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import type { ExtensionDTO } from '@nobot/shared'
import { QueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { loadExtensions } from '../extensions/runtime'
import { setSessionAnonymous, useSessionStore } from '../stores/session'
import { getCommand } from './registry'
import { type CommandContext, runCommandLine } from './run'

beforeEach(() => {
  useSessionStore.setState({
    status: 'authenticated',
    user: { id: 'fixture-user', handle: 'fixture', name: 'Fixture', isAdmin: true },
  })
})
afterEach(() => setSessionAnonymous())

test('后端扩展命令自动注册、别名调用、重载和停用清理', async () => {
  let enabled = true
  const dto = (): ExtensionDTO => ({
    id: 'test-remote-commands',
    name: 'test',
    description: '',
    version: '1',
    source: 'local',
    enabled,
    provides: { macros: [], tools: [], hooks: [] },
    settingsSchema: [],
    settings: {},
    author: '',
    client: { script: false, style: false },
    permissions: null,
    detected: { server: false, client: false, routes: false, tools: false, hooks: false },
    permissionWarnings: [],
    needsApproval: false,
    git: null,
    revision: '1',
    hasRoutes: true,
    commands: [{ name: 'test-remote-command', aliases: ['test-remote-alias'], description: 'test', args: [] }],
  })
  const list = spyOn(api, 'listExtensions').mockImplementation(async () => [dto()])
  const execute = spyOn(api, 'extensionCommand').mockImplementation(async (id, name, chatId, args, text) => {
    expect([id, name, chatId, args, text]).toEqual(['test-remote-commands', 'test-remote-command', 'chat', {}, 'hello'])
    return { result: 'remote-result' }
  })
  const qc = new QueryClient()
  const ctx: CommandContext = {
    chatId: 'chat',
    api,
    generate: async () => {},
    refresh: async () => {},
    getInput: () => '',
    setInput: () => {},
    notify: () => {},
    prompt: async () => null,
    getActiveSets: async () => [],
  }
  try {
    await loadExtensions(qc)
    expect(getCommand('test-remote-alias')).toBeDefined()
    expect(await runCommandLine('/test-remote-alias hello', ctx)).toBe('remote-result')
    await loadExtensions(qc, 'test-remote-commands')
    expect(getCommand('test-remote-command')).toBeDefined()
    enabled = false
    await loadExtensions(qc)
    expect(getCommand('test-remote-command')).toBeUndefined()
    expect(getCommand('test-remote-alias')).toBeUndefined()
  } finally {
    enabled = false
    await loadExtensions(qc)
    list.mockRestore()
    execute.mockRestore()
    qc.clear()
  }
})
