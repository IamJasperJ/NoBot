import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import type { ExtensionDTO, ExtensionInstallPreview } from '@nobot/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { setSessionAnonymous, useSessionStore } from '../stores/session'
import { ApiRequestError } from './client'
import {
  useApproveExtension,
  useCatalogSources,
  useExtensionCatalog,
  useExtensionGit,
  useGitStatus,
  useInstallFlow,
  useReloadExtensions,
} from './extensionManager'
import { keys } from './queries'

// fetch、effect 观察与 runtime 的全局状态隔离，避免影响其他前端测试。
beforeEach(() => {
  useSessionStore.setState({
    status: 'authenticated',
    user: { id: 'fixture-user', handle: 'fixture', name: 'Fixture', isAdmin: true },
  })
})
afterEach(() => setSessionAnonymous())

test('扩展管理 hooks：请求、刷新、安装生命周期与错误传递', async () => {
  if (!process.env.EXTENSION_MANAGER_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', 'apps/web/src/api/extensionManager.test.tsx'], {
      env: { ...process.env, EXTENSION_MANAGER_TEST_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, `${out}\n${err}`).toBe(0)
    return
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const extension: ExtensionDTO = {
    id: 'git/id',
    name: '扩展',
    description: '',
    author: '',
    version: '1',
    source: 'local',
    enabled: false,
    client: { script: false, style: false },
    hasRoutes: false,
    provides: { macros: [], hooks: [], tools: [] },
    settingsSchema: [],
    settings: {},
    permissions: null,
    detected: { server: false, client: false, routes: false, tools: false, hooks: false },
    permissionWarnings: [],
    needsApproval: false,
    git: null,
    revision: '1',
  }
  const preview = (token: string): ExtensionInstallPreview => ({
    token,
    manifest: { id: extension.id, name: '扩展', description: '', author: '', version: '1' },
    permissions: null,
    detected: { server: false, client: false },
    warnings: [],
    ref: 'main',
    commit: 'abc',
    exists: false,
  })
  const requests: { url: string; method: string; body: unknown }[] = []
  let token = 0
  let failure: string | undefined
  let releasePreview: (() => void) | undefined
  let delayPreview = false
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input)
        requests.push({
          url,
          method: init?.method ?? 'GET',
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        })
        if (failure === url)
          return Response.json({ error: { code: 'NEEDS_APPROVAL', message: '请确认权限' } }, { status: 409 })
        if (url === '/api/extensions/git') return Response.json({ available: true, version: 'git 2' })
        if (url === '/api/extensions/install/preview') {
          if (delayPreview)
            await new Promise<void>((resolve) => {
              releasePreview = resolve
            })
          return Response.json(preview(`token-${++token}`))
        }
        if (url === '/api/extensions/install/confirm') return Response.json(extension)
        if (url === '/api/extensions' || url === '/api/extensions/reload') return Response.json([extension])
        if (url.endsWith('/update')) return Response.json({ extension, permissionsChanged: true })
        if (url.endsWith('/branches')) return Response.json({ current: 'main', branches: ['main', 'v1'] })
        if (url.startsWith('/api/extensions/catalog/sources'))
          return Response.json({ urls: ['https://example.com/index.json'] })
        if (url.startsWith('/api/extensions/catalog')) return Response.json({ sources: [] })
        if (url.endsWith('/check-update') || url.endsWith('/switch') || init?.method === 'PATCH')
          return Response.json(extension)
        return Response.json({ ok: true })
      },
      { preconnect: fetch.preconnect },
    ),
  )
  const invalidations = spyOn(qc, 'invalidateQueries')
  // 仓库没有 DOM 测试依赖；服务端渲染取得真实 hooks，显式执行查询和安装生命周期 effect。
  const effects = spyOn(React, 'useEffect')
  const render = <T,>(hook: () => T): T => {
    let result: T | undefined
    function Probe() {
      result = hook()
      return null
    }
    renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    )
    return result as T
  }
  const refreshed = () => {
    expect(invalidations.mock.calls.map(([filters]) => filters?.queryKey)).toContainEqual(keys.extensions)
    expect(invalidations.mock.calls.map(([filters]) => filters?.queryKey)).toContainEqual(keys.tools)
    expect(requests.some((request) => request.url === '/api/extensions')).toBe(true)
    invalidations.mockClear()
    requests.length = 0
  }
  try {
    expect(render(useGitStatus).isPending).toBe(true)
    await qc.getQueryCache().find({ queryKey: keys.gitStatus })!.fetch()
    expect(render(useGitStatus).data).toEqual({ available: true, version: 'git 2' })
    expect(requests.at(-1)?.url).toBe('/api/extensions/git')
    requests.length = 0
    const catalog = render(() => useExtensionCatalog(false))
    expect(
      (qc.getQueryCache().find({ queryKey: keys.extensionCatalog })?.options as { enabled?: boolean } | undefined)
        ?.enabled,
    ).toBe(false)
    expect(requests).toHaveLength(0)
    render(() => useExtensionCatalog(true))
    await qc.getQueryCache().find({ queryKey: keys.extensionCatalog })!.fetch()
    expect(requests.at(-1)?.url).toBe('/api/extensions/catalog')
    await catalog.refresh()
    expect(requests.at(-1)?.url).toBe('/api/extensions/catalog?refresh=1')
    expect(render(() => useExtensionCatalog(false)).data).toEqual({ sources: [] })
    const sources = render(useCatalogSources)
    await qc.getQueryCache().find({ queryKey: keys.catalogSources })!.fetch()
    expect(render(useCatalogSources).urls).toEqual(['https://example.com/index.json'])
    await sources.save(['https://example.com/index.json'])
    expect(requests).toContainEqual({
      url: '/api/extensions/catalog/sources',
      method: 'PUT',
      body: { urls: ['https://example.com/index.json'] },
    })
    expect(qc.getQueryState(keys.extensionCatalog)?.isInvalidated).toBe(true)
    requests.length = 0
    invalidations.mockClear()
    const git = render(() => useExtensionGit(extension.id))
    expect(await git.loadBranches()).toEqual({ current: 'main', branches: ['main', 'v1'] })
    expect(requests).toEqual([{ url: '/api/extensions/git%2Fid/branches', method: 'GET', body: undefined }])
    expect(invalidations).not.toHaveBeenCalled()
    expect(await git.checkUpdate()).toEqual(extension)
    refreshed()
    expect((await git.update()).permissionsChanged).toBe(true)
    expect(requests[0]?.url).toBe('/api/extensions/git%2Fid/update')
    refreshed()
    expect(await git.switchRef('release/v2')).toEqual(extension)
    expect(requests[0]).toEqual({ url: '/api/extensions/git%2Fid/switch', method: 'POST', body: { ref: 'release/v2' } })
    refreshed()
    await git.uninstall()
    expect(requests[0]?.method).toBe('DELETE')
    refreshed()
    const approval = render(useApproveExtension)
    expect(await approval.approve(extension.id)).toEqual(extension)
    expect(requests[0]).toEqual({
      url: '/api/extensions/git%2Fid',
      method: 'PATCH',
      body: { enabled: true, approvePermissions: true },
    })
    refreshed()
    failure = '/api/extensions/git%2Fid'
    await expect(approval.approve(extension.id)).rejects.toBeInstanceOf(ApiRequestError)
    await expect(approval.approve(extension.id)).rejects.toMatchObject({ code: 'NEEDS_APPROVAL', status: 409 })
    expect(invalidations).not.toHaveBeenCalled()
    failure = undefined
    expect(await render(useReloadExtensions).reload()).toEqual([extension])
    refreshed()
    effects.mockClear()
    const install = render(useInstallFlow)
    const effect = effects.mock.calls.at(-1)?.[0]
    const unmount = effect?.()
    expect(await install.start({ url: 'https://example.com/one.git', ref: 'main' })).toEqual(preview('token-1'))
    await install.start({ url: 'https://example.com/two.git' })
    expect(requests.slice(0, 3)).toEqual([
      {
        url: '/api/extensions/install/preview',
        method: 'POST',
        body: { url: 'https://example.com/one.git', ref: 'main' },
      },
      { url: '/api/extensions/install/cancel', method: 'POST', body: { token: 'token-1' } },
      { url: '/api/extensions/install/preview', method: 'POST', body: { url: 'https://example.com/two.git' } },
    ])
    expect(await install.confirm(true)).toEqual(extension)
    expect(requests[3]?.body).toEqual({ token: 'token-2', enable: true })
    refreshed()
    await install.cancel()
    expect(requests).toHaveLength(0)
    await expect(install.confirm(false)).rejects.toThrow('没有待确认')
    await install.start({ url: 'https://example.com/three.git' })
    await install.confirm(false)
    expect(requests[1]?.body).toEqual({ token: 'token-3', enable: false })
    refreshed()
    failure = '/api/extensions/install/preview'
    await expect(install.start({ url: 'https://example.com/failure.git' })).rejects.toBeInstanceOf(ApiRequestError)
    failure = undefined
    await install.start({ url: 'https://example.com/cancel.git' })
    failure = '/api/extensions/install/cancel'
    await expect(install.cancel()).rejects.toBeInstanceOf(ApiRequestError)
    failure = undefined
    await install.cancel()
    expect(requests.at(-1)?.body).toEqual({ token: 'token-4' })
    // 确认失败保留令牌，调用方可重试或取消。
    await install.start({ url: 'https://example.com/retry.git' })
    failure = '/api/extensions/install/confirm'
    await expect(install.confirm(true)).rejects.toBeInstanceOf(ApiRequestError)
    failure = undefined
    await install.cancel()
    expect(requests.at(-1)?.body).toEqual({ token: 'token-5' })
    delayPreview = true
    const pending = install.start({ url: 'https://example.com/late.git' })
    await Bun.sleep(0)
    expect(typeof unmount).toBe('function')
    if (typeof unmount === 'function') unmount()
    releasePreview?.()
    await pending
    await Bun.sleep(0)
    expect(requests.at(-1)).toEqual({
      url: '/api/extensions/install/cancel',
      method: 'POST',
      body: { token: 'token-6' },
    })
    delayPreview = false
    effects.mockClear()
    const secondInstall = render(useInstallFlow)
    const secondUnmount = effects.mock.calls.at(-1)?.[0]()
    await Promise.all([
      secondInstall.start({ url: 'https://example.com/first.git' }),
      secondInstall.start({ url: 'https://example.com/second.git' }),
    ])
    expect(requests.slice(-3).map((request) => request.url)).toEqual([
      '/api/extensions/install/preview',
      '/api/extensions/install/cancel',
      '/api/extensions/install/preview',
    ])
    if (typeof secondUnmount === 'function') secondUnmount()
    await Bun.sleep(0)
    expect(requests.at(-1)?.body).toEqual({ token: 'token-8' })
  } finally {
    effects.mockRestore()
    invalidations.mockRestore()
    fetchMock.mockRestore()
    qc.clear()
  }
})
