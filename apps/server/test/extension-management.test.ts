import { expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 数据库单例隔离到子进程，整个场景只访问临时 DATA_DIR。
test('扩展管理：权限、Git 安装更新切换、热重载及目录缓存', async () => {
  if (!process.env.EXT_MANAGEMENT_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, EXT_MANAGEMENT_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => child.kill(), 90000)
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, `${out}\n${err}`).toBe(0)
    } finally {
      clearTimeout(timer)
    }
    return
  }
  const directory = await mkdtemp(join(tmpdir(), 'extension-management-'))
  process.env.DATA_DIR = join(directory, 'data')
  let sqlite: typeof import('../src/db/client').sqlite | undefined
  try {
    const { bootstrap } = await import('../src/bootstrap')
    await bootstrap()
    const client = await import('../src/db/client')
    sqlite = client.sqlite
    const registry = await import('../src/extensions/registry')
    const git = await import('../src/services/extension-git')
    const permissions = await import('../src/extensions/permissions')
    const { extensionPermissionsSchema } = await import('@ai-parter/shared')
    const { app } = await import('../src/app')
    const request = (path: string, method = 'POST', body?: unknown) =>
      app.request(`/api/extensions${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    const full = extensionPermissionsSchema.parse({
      server: true,
      routes: true,
      tools: true,
      hooks: true,
      network: ['EXAMPLE.com'],
    })
    expect(
      permissions.isApproved(
        permissions.permissionFingerprint(null, { server: true }),
        permissions.permissionFingerprint(full, {}),
      ),
    ).toBe(true)
    expect(
      permissions.isApproved(
        permissions.permissionFingerprint(full, { client: true }),
        permissions.permissionFingerprint(full, {}),
      ),
    ).toBe(false)
    expect(permissions.isApproved('[]', 'broken')).toBe(false)
    expect(permissions.permissionWarnings(null, { server: true, client: true })).toHaveLength(3)
    expect(permissions.permissionWarnings(full, { server: true })).toEqual([])
    expect(
      permissions.detectPermissions(
        { id: 'test', name: '', version: '', description: '', hooks: { onEvent() {} }, tools: () => [], routes() {} },
        undefined,
        true,
      ),
    ).toMatchObject({ server: true, tools: true, hooks: true, routes: true })
    for (const url of [
      '-evil',
      'file:///tmp/repo',
      '/tmp/repo',
      'ext::sh evil',
      'http://host/repo',
      'https:host/repo',
      'https://host/repo\n-e',
      'git@-host:repo',
      'https://u:p@host/repo',
    ]) {
      expect(() => git.validateGitUrl(url)).toThrow()
      expect((await request('/install/preview', 'POST', { url })).status).toBe(400)
    }
    expect(git.validateGitUrl('https://example.com/repo.git')).toBe('https://example.com/repo.git')
    expect(git.validateGitUrl('git@example.com:repo.git')).toBe('git@example.com:repo.git')
    for (const ref of ['--upload-pack=evil', 'a..b', 'a b', 'HEAD~1']) expect(() => git.validateGitRef(ref)).toThrow()
    const folder = join(process.env.DATA_DIR!, 'extensions', 'manual')
    await mkdir(folder, { recursive: true })
    const manifest = {
      id: 'manual',
      name: '手动',
      version: '1',
      description: '',
      server: 'server.ts',
      client: 'client.js',
    }
    await Bun.write(join(folder, 'manifest.json'), JSON.stringify(manifest))
    await Bun.write(join(folder, 'client.js'), 'export default () => {}')
    await Bun.write(join(folder, 'value.ts'), "export default 'one'")
    await Bun.write(join(folder, '../host-relative.ts'), 'export default true')
    await Bun.write(
      join(folder, 'server.ts'),
      `import value from './value.ts'; import host from '../host-relative.ts'; if (!host) throw new Error('relative import failed'); export default { macros: { sample: () => value }, tools: [], hooks: { transformInput: (text) => text + '!' }, routes(app) { app.get('/old', c => c.text('one')) }, dispose() { globalThis.__extensionDisposed = true } }`,
    )
    const hidden = join(process.env.DATA_DIR!, 'extensions', '.hidden')
    await mkdir(hidden)
    await Bun.write(join(hidden, 'index.ts'), "throw new Error('hidden must not run')")
    await registry.loadLocalExtensions()
    expect(registry.listExtensions().filter((entry) => entry.source === 'local')).toHaveLength(1)
    expect(registry.listExtensions().find((entry) => entry.id === 'manual')).toMatchObject({
      needsApproval: true,
      enabled: false,
      detected: { server: true, client: true, hooks: true, routes: true },
    })
    client.setSetting('extensionsEnabled', { manual: true })
    expect(registry.collectMacros('').sample).toBeUndefined()
    expect(registry.runTransform('transformInput', 'text', '')).toBe('text')
    expect((await app.request('/api/ext/manual/old')).status).toBe(404)
    expect((await request('/manual/client.js', 'GET')).status).toBe(404)
    const denied = await request('/manual', 'PATCH', { enabled: true })
    expect(denied.status).toBe(409)
    expect(await denied.json()).toMatchObject({ error: { code: 'NEEDS_APPROVAL' } })
    expect((await request('/manual', 'PATCH', { enabled: true, approvePermissions: true })).status).toBe(200)
    expect(registry.collectMacros('').sample?.('')).toBe('one')
    expect(await (await app.request('/api/ext/manual/old')).text()).toBe('one')
    const builtin = registry.extensionLocation('regex')
    const oldMacro = registry.collectMacros('').sample!
    const oldRevision = registry.listExtensions().find((entry) => entry.id === 'manual')!.revision
    // 同时修改入口和相对依赖，确认运行目录能刷新整个本地模块树。
    await Bun.write(join(folder, 'value.ts'), "export default 'two changed'")
    await Bun.write(
      join(folder, 'server.ts'),
      `import value from './value.ts'; import host from '../host-relative.ts'; if (!host) throw new Error('relative import failed'); export default { macros: { sample: () => value }, hooks: { transformInput: (text) => text + '!' }, routes(app) { app.get('/new', c => c.text('two')) } }`,
    )
    await registry.reloadExtension('manual', folder)
    expect((globalThis as typeof globalThis & { __extensionDisposed?: boolean }).__extensionDisposed).toBe(true)
    expect(registry.extensionLocation('regex')).toBe(builtin)
    expect(oldMacro('')).toBe('')
    expect(registry.collectMacros('').sample?.('')).toBe('two changed')
    expect((await app.request('/api/ext/manual/old')).status).toBe(404)
    expect(await (await app.request('/api/ext/manual/new')).text()).toBe('two')
    expect(registry.listExtensions().find((entry) => entry.id === 'manual')!.revision).not.toBe(oldRevision)
    await Bun.write(
      join(folder, 'manifest.json'),
      JSON.stringify({ ...manifest, permissions: { ...full, client: true, network: ['new.example.com'] } }),
    )
    await registry.reloadExtension('manual', folder)
    expect(registry.listExtensions().find((entry) => entry.id === 'manual')!.needsApproval).toBe(true)
    expect(registry.collectMacros('').sample).toBeUndefined()
    registry.updateExtension('manual', { approvePermissions: true })
    await Bun.write(join(folder, 'manifest.json'), JSON.stringify(manifest))
    await registry.reloadExtension('manual', folder)
    expect(registry.listExtensions().find((entry) => entry.id === 'manual')!.needsApproval).toBe(false)
    expect((await request('/manual/update')).status).toBe(400)
    expect((await request('/regex', 'DELETE')).status).toBe(400)

    const catalog = await import('../src/services/extension-catalog')
    expect((await request('/catalog/sources', 'PUT', { urls: ['file:///bad'] })).status).toBe(400)
    expect(
      (
        await request('/catalog/sources', 'PUT', {
          urls: ['https://catalog.invalid/good', 'https://catalog.invalid/fail'],
        })
      ).status,
    ).toBe(200)
    expect(await (await request('/catalog/sources', 'GET')).json()).toEqual({
      urls: ['https://catalog.invalid/good', 'https://catalog.invalid/fail'],
    })
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          if (String(input).endsWith('/large'))
            return new Response('x', { headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) } })
          if (String(input).endsWith('/stream-large')) return new Response('x'.repeat(2 * 1024 * 1024 + 1))
          if (String(input).endsWith('/invalid')) return new Response('invalid json')
          if (String(input).endsWith('/array'))
            return Response.json([{ id: 'array', name: 'Array', repo: 'https://example.com/array' }])
          if (String(input).endsWith('/fail')) return new Response('bad', { status: 500 })
          return Response.json({
            extensions: [
              { id: 'manual', name: '手动', repo: 'https://example.com/manual' },
              { id: '../bad' },
              { id: 'unsafe', name: 'x', repo: 'file:///x' },
            ],
          })
        },
        { preconnect: fetch.preconnect },
      ),
    )
    try {
      const result = await catalog.extensionCatalog()
      expect(result.sources[0]!.items).toHaveLength(1)
      expect(result.sources[0]!.items[0]).toMatchObject({ installed: true, installedVersion: '1' })
      expect(result.sources[1]).toMatchObject({ ok: false, items: [] })
      await catalog.extensionCatalog()
      expect(fetchMock).toHaveBeenCalledTimes(2)
      await catalog.extensionCatalog(true)
      expect(fetchMock).toHaveBeenCalledTimes(4)
      client.setSetting('extdata:manual:value', 1)
      client.setSetting('ext:manual', { x: 1 })
      await git.uninstallExtension('manual')
      expect(client.getSetting('extdata:manual:value')).toBeUndefined()
      expect(client.getSetting('ext:manual')).toBeUndefined()
      expect(client.getSetting<Record<string, string>>('extensionsApproved')?.manual).toBeUndefined()
      expect((await catalog.extensionCatalog()).sources[0]!.items[0]!.installed).toBe(false)
      catalog.setCatalogSources([
        'https://catalog.invalid/large',
        'https://catalog.invalid/stream-large',
        'https://catalog.invalid/invalid',
        'https://catalog.invalid/array',
      ])
      const boundaries = await catalog.extensionCatalog()
      expect(boundaries.sources.map((source) => source.ok)).toEqual([false, false, false, true])
      expect(boundaries.sources[0]!.error).toContain('2MB')
      expect(boundaries.sources[1]!.error).toContain('2MB')
      expect(boundaries.sources[3]!.items[0]!.id).toBe('array')
    } finally {
      fetchMock.mockRestore()
    }

    if (!(await git.gitStatus()).available) {
      console.log('服务器没有 Git，跳过 Git 仓库集成场景')
      return
    }
    const remote = join(directory, 'remote.git')
    const work = join(directory, 'work')
    await git.runGit(['init', '--bare', '--initial-branch=main', remote])
    await git.runGit(['clone', remote, work])
    await git.runGit(['config', 'user.email', 'fixture@example.com'], work)
    await git.runGit(['config', 'user.name', 'Fixture'], work)
    const gitManifest = {
      id: 'git-fixture',
      name: 'Git 测试',
      version: '1',
      description: '',
      server: 'server.ts',
      permissions: { server: true, routes: true },
    }
    const writeVersion = async (version: string, tools = false) => {
      await Bun.write(join(work, 'manifest.json'), JSON.stringify({ ...gitManifest, version }))
      await Bun.write(
        join(work, 'server.ts'),
        `globalThis.__gitExtensionImported = true; export default { routes(app) { app.get('/${version}', c => c.text('${version}')) }, ${tools ? "tools: [{ name: 'fixture_tool', description: '', parameters: { type: 'object' }, run: () => ({ content: '' }) }]," : ''} }`,
      )
      await git.runGit(['add', '.'], work)
      await git.runGit(['commit', '-m', version], work)
      await git.runGit(['push', 'origin', 'main'], work)
    }
    await writeVersion('v1')
    await git.runGit(['tag', 'stable'], work)
    await git.runGit(['branch', 'alternate'], work)
    await git.runGit(['push', 'origin', '--tags', 'alternate'], work)
    const preview = await git.previewRepository(remote)
    expect(preview).toMatchObject({ exists: false, detected: { server: true, client: false } })
    expect(registry.listExtensions().some((entry) => entry.id === 'git-fixture')).toBe(false)
    expect(
      (globalThis as typeof globalThis & { __gitExtensionImported?: boolean }).__gitExtensionImported,
    ).toBeUndefined()
    const installed = await git.confirmInstall(preview.token, true)
    expect(installed).toMatchObject({ enabled: true, needsApproval: false, version: 'v1' })
    expect(installed.git!.commit).toBe(installed.revision)
    expect(await (await app.request('/api/ext/git-fixture/v1')).text()).toBe('v1')
    await writeVersion('v2')
    const checked = await git.checkExtensionUpdate('git-fixture')
    expect(checked.git!.hasUpdate).toBe(true)
    expect(checked.git!.checkedAt).toBeNumber()
    const updated = await git.updateGitExtension('git-fixture')
    expect(updated).toMatchObject({ permissionsChanged: false, extension: { version: 'v2', enabled: true } })
    expect((await app.request('/api/ext/git-fixture/v1')).status).toBe(404)
    expect(await (await app.request('/api/ext/git-fixture/v2')).text()).toBe('v2')
    const branches = await git.extensionBranches('git-fixture')
    expect(branches.branches).toContain('origin/alternate')
    expect(branches.branches).toContain('stable')
    expect((await git.switchExtension('git-fixture', 'stable')).version).toBe('v1')
    expect((await git.switchExtension('git-fixture', 'alternate')).version).toBe('v1')
    expect((await git.switchExtension('git-fixture', 'origin/alternate')).version).toBe('v1')
    await git.switchExtension('git-fixture', 'main')
    const location = registry.extensionLocation('git-fixture').directory!
    await Bun.write(join(location, 'dirty'), 'local change')
    await expect(git.updateGitExtension('git-fixture')).rejects.toMatchObject({ code: 'GIT_DIRTY' })
    await rm(join(location, 'dirty'))
    await writeVersion('v3', true)
    const changed = await git.updateGitExtension('git-fixture')
    expect(changed).toMatchObject({ permissionsChanged: true, extension: { enabled: false, needsApproval: true } })
    expect((await app.request('/api/ext/git-fixture/v3')).status).toBe(404)
    expect(registry.extensionLocation('regex')).toBe(builtin)
    const cancel = await git.previewRepository(remote, 'stable')
    await git.cancelInstall(cancel.token)
    await expect(git.confirmInstall(cancel.token, true)).rejects.toMatchObject({ code: 'INSTALL_EXPIRED' })
    const replacement = await git.previewRepository(remote)
    expect(replacement.exists).toBe(true)
    expect((await git.confirmInstall(replacement.token, false)).enabled).toBe(false)
    await git.uninstallExtension('git-fixture')
    expect(registry.listExtensions().some((entry) => entry.id === 'git-fixture')).toBe(false)
    // 缺失 manifest 的仓库不能留在 staging 内。
    await rm(join(work, 'manifest.json'))
    await git.runGit(['add', '.'], work)
    await git.runGit(['commit', '-m', 'broken'], work)
    await git.runGit(['push'], work)
    await expect(git.previewRepository(remote)).rejects.toMatchObject({ code: 'INVALID_EXTENSION' })
    expect(await readdir(join(process.env.DATA_DIR!, 'extensions', '.staging'))).toEqual([])
    await mkdir(join(process.env.DATA_DIR!, 'extensions', '.staging', 'orphan'))
    await git.cleanupExtensionStaging()
    expect(await readdir(join(process.env.DATA_DIR!, 'extensions', '.staging'))).toEqual([])
  } finally {
    sqlite?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 100000)
