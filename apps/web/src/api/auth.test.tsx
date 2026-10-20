import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import type { CurrentUserDTO } from '@nobot/shared'
import { initSession, prepareUserCache, setSessionAnonymous, useSessionStore } from '../stores/session'
import { useSpriteLayout } from '../stores/spriteLayout'
import { useUi } from '../stores/ui'
import { useVn } from '../stores/vn'
import {
  useChangePassword,
  useCreateUser,
  useDeleteUser,
  useLogin,
  useLogout,
  usersKey,
  useSession,
  useUpdateUser,
  useUsers,
} from './auth'
import { ApiRequestError, api } from './client'
import { apiFetch } from './fetch'
import { setupHooks } from './hooks.test-utils'

const user: CurrentUserDTO = { id: 'u1', handle: 'alice', name: 'Alice', isAdmin: true }
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
let storage: Map<string, string>
let fetcher: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>
let response: () => Promise<Response>
let reloads = 0
const calls: { url: string; init?: RequestInit }[] = []

beforeEach(() => {
  storage = new Map()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      get length() {
        return storage.size
      },
      key: (index: number) => [...storage.keys()][index] ?? null,
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value)
      },
      removeItem: (key: string) => {
        storage.delete(key)
      },
    },
  })
  reloads = 0
  calls.length = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        reload: () => {
          reloads++
        },
      },
    },
  })
  response = async () => Response.json(user)
  fetcher = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init })
        return response()
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch,
  )
  useSessionStore.setState({ status: 'loading', user: null, setupRequired: false, error: null })
})

afterEach(() => {
  fetcher.mockRestore()
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
  setSessionAnonymous()
  useUi.setState({ characterId: null, groupId: null, chatId: null })
  useVn.setState({ mode: {}, read: [], cinema: {} })
  useSpriteLayout.setState({ vn: {}, side: {}, outfits: {} })
})

function fail(status = 401, code = 'UNAUTHORIZED', message = '会话已失效') {
  response = async () => Response.json({ error: { code, message } }, { status })
}

test('me 初始化合并并发调用，清理缓存后发布用户；401 为匿名，服务错误可重试', async () => {
  const first = initSession()
  expect(initSession()).toBe(first)
  expect(useSessionStore.getState().status).toBe('loading')
  await first
  expect(calls).toHaveLength(1)
  expect(calls[0]?.url).toBe('/api/auth/me')
  expect(useSessionStore.getState()).toMatchObject({ status: 'authenticated', user, error: null })
  expect(storage.get('nobot:lastUser')).toBe('alice')
  expect(setupHooks().render(useSession).status).toBe('loading')

  fail()
  await initSession()
  expect(useSessionStore.getState()).toMatchObject({ status: 'anonymous', user: null, error: null })
  fail(503, 'SETUP_REQUIRED', '请先配置管理员')
  await initSession()
  expect(useSessionStore.getState()).toMatchObject({ status: 'anonymous', setupRequired: true })
  expect(useSessionStore.getState().error).toBeInstanceOf(ApiRequestError)
  fail()
  await apiFetch('/api/app-settings')
  expect(useSessionStore.getState().setupRequired).toBe(true)
  expect(useSessionStore.getState().error).toMatchObject({ code: 'SETUP_REQUIRED' })
  response = async () => {
    throw new TypeError('offline')
  }
  await initSession()
  expect(useSessionStore.getState().error?.message).toBe('offline')
  response = async () => Response.json(user)
  await initSession()
  expect(useSessionStore.getState().status).toBe('authenticated')
})

test('切换用户与旧版本首次登录清除数据 ID，保留本机偏好；同一用户保留选择', () => {
  const dataKeys = [
    'nobot:selection',
    'nobot:sprite-layout',
    'vn-mode',
    'vn-read',
    'translation:view:message',
    'ai-parter:selection',
    'ai-parter:sprite-layout',
  ]
  const preferenceKeys = [
    'nobot:appearance',
    'nobot:audio',
    'nobot:language',
    'ext-settings-collapsed:regex',
    'ai-parter:appearance',
    'ai-parter:language',
  ]
  for (const previous of [undefined, 'bob']) {
    storage.clear()
    if (previous) storage.set('nobot:lastUser', previous)
    for (const key of [...dataKeys, ...preferenceKeys]) storage.set(key, 'old')
    useUi.setState({ characterId: 'old', groupId: 'old', chatId: 'old', focusId: 'old' })
    useVn.setState({ mode: { old: 'vn' }, read: ['old:1'], cinema: { old: true } })
    useSpriteLayout.setState({ side: { old: { scale: 2 } }, outfits: { old: { old: 'dress' } } })
    prepareUserCache('alice')
    for (const key of dataKeys) expect(storage.has(key), key).toBe(false)
    for (const key of preferenceKeys) expect(storage.get(key), key).toBe('old')
    expect(useUi.getState()).toMatchObject({ characterId: null, groupId: null, chatId: null, focusId: null })
    expect(useVn.getState()).toMatchObject({ mode: {}, read: [], cinema: {} })
    expect(useSpriteLayout.getState()).toMatchObject({ vn: {}, side: {}, outfits: {} })
  }
  storage.set('nobot:selection', 'saved')
  useUi.setState({ chatId: 'saved' })
  prepareUserCache('alice')
  expect(storage.get('nobot:selection')).toBe('saved')
  expect(useUi.getState().chatId).toBe('saved')
})

test('存储不可用时仍可初始化，不把清理失败的缓存标为新用户所有', async () => {
  storage.set('nobot:lastUser', 'bob')
  storage.set('nobot:selection', 'old')
  const remove = spyOn(localStorage, 'removeItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  await initSession()
  expect(useSessionStore.getState().status).toBe('authenticated')
  expect(storage.get('nobot:lastUser')).toBe('bob')
  remove.mockRestore()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get: () => {
      throw new Error('blocked')
    },
  })
  await initSession()
  expect(useSessionStore.getState().status).toBe('authenticated')
})

test('JSON、Blob、流和扩展请求的 401 通知匿名；me、login、外部 URL 不通知', async () => {
  fail()
  for (const request of [
    () => api.listUsers(),
    () => api.spriteCutoutPreview('c', 's', 'algorithm'),
    () => apiFetch('/api/chats/c/generate', { method: 'POST' }),
    () => apiFetch(new URL('http://localhost/api/ext/example/options')),
    () => apiFetch(new Request('http://localhost/api/ext/audio/cache')),
    () => api.logout(),
  ]) {
    useSessionStore.setState({ status: 'authenticated', user })
    await request().catch(() => {})
    expect(useSessionStore.getState()).toMatchObject({ status: 'anonymous', user: null })
  }
  for (const request of [
    () => api.authMe(),
    () => api.login({ handle: 'alice', password: 'wrong' }),
    () => apiFetch('https://example.com/api/private'),
    () => apiFetch('/other'),
  ]) {
    useSessionStore.setState({ status: 'authenticated', user })
    await request().catch(() => {})
    expect(useSessionStore.getState().status).toBe('authenticated')
  }
  response = async () => new Response('data: ok\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  expect(await (await apiFetch('/api/chats/c/stream')).text()).toBe('data: ok\n\n')
})

test('初始化过程中会话失效，迟到的 me 不能恢复已登录状态', async () => {
  let resolve!: (response: Response) => void
  let requested!: () => void
  const requestStarted = new Promise<void>((done) => {
    requested = done
  })
  response = () =>
    new Promise<Response>((done) => {
      resolve = done
      requested()
    })
  const started = initSession()
  await requestStarted
  setSessionAnonymous()
  resolve(Response.json(user))
  await started
  expect(useSessionStore.getState().status).toBe('anonymous')
})

test('登录登出成功刷新整页，503 / 429 保留 ApiRequestError，修改密码不刷新', async () => {
  const { render, qc } = setupHooks()
  const login = render(useLogin)
  fail(503, 'SETUP_REQUIRED', '请先配置管理员')
  await expect(login.mutateAsync({ handle: 'alice', password: 'secret' })).rejects.toMatchObject({
    code: 'SETUP_REQUIRED',
    message: '请先配置管理员',
  })
  expect(useSessionStore.getState().setupRequired).toBe(true)
  fail(429, 'RATE_LIMITED', '稍后重试')
  await expect(login.mutateAsync({ handle: 'alice', password: 'secret' })).rejects.toBeInstanceOf(ApiRequestError)
  expect(useSessionStore.getState().setupRequired).toBe(false)
  expect(reloads).toBe(0)
  response = async () => Response.json(user)
  await login.mutateAsync({ handle: 'alice', password: 'secret' })
  expect(reloads).toBe(1)
  response = async () => Response.json({ ok: true })
  await render(useChangePassword).mutateAsync({ oldPassword: 'old', newPassword: 'new-password' })
  expect(calls.at(-1)).toMatchObject({
    url: '/api/auth/password',
    init: { method: 'PUT', body: JSON.stringify({ oldPassword: 'old', newPassword: 'new-password' }) },
  })
  expect(reloads).toBe(1)
  await render(useLogout).mutateAsync()
  expect(reloads).toBe(2)
  qc.clear()
})

test('管理员 hooks 编码路径，提交数据并使用户列表失效；普通用户不自动查询', async () => {
  const { qc, render } = setupHooks()
  render(useUsers)
  expect(calls).toHaveLength(0)
  useSessionStore.setState({ status: 'authenticated', user })
  render(useUsers)
  const query = qc.getQueryCache().find({ queryKey: usersKey })!
  response = async () => Response.json([user])
  await query.fetch()
  expect(calls.at(-1)?.url).toBe('/api/admin/users')
  response = async () => Response.json(user)
  await render(useCreateUser).mutateAsync({ handle: 'bob', name: 'Bob', password: 'password' })
  expect(query.state.isInvalidated).toBe(true)
  expect(calls.at(-1)?.init?.method).toBe('POST')
  qc.setQueryData(usersKey, [user])
  await render(useUpdateUser).mutateAsync({ id: 'a/b', input: { disabled: true } })
  expect(calls.at(-1)).toMatchObject({
    url: '/api/admin/users/a%2Fb',
    init: { method: 'PATCH', body: '{"disabled":true}' },
  })
  expect(query.state.isInvalidated).toBe(true)
  qc.setQueryData(usersKey, [user])
  await render(useDeleteUser).mutateAsync('a/b')
  expect(calls.at(-1)).toMatchObject({ url: '/api/admin/users/a%2Fb', init: { method: 'DELETE' } })
  expect(query.state.isInvalidated).toBe(true)
  qc.clear()
})
