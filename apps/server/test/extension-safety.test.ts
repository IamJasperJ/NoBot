import { expect, spyOn, test } from 'bun:test'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('未批准、权限增加和 API 不兼容均不执行顶层代码；新版本加载失败恢复旧版', async () => {
  if (!process.env.EXT_SAFETY_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, EXT_SAFETY_CHILD: '1' },
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
  const dir = await mkdtemp(join(tmpdir(), 'extension-safety-'))
  process.env.DATA_DIR = join(dir, 'data')
  const { bootstrap } = await import('../src/bootstrap')
  await bootstrap()
  const registry = await import('../src/extensions/registry')
  const git = await import('../src/services/extensions/extension-git')
  const { paths } = await import('../src/env')
  const { getSetting, setSetting } = await import('../src/db/client')
  const source = join(dir, 'repo')
  await mkdir(source)
  const manifest = {
    id: 'safe',
    name: 'safe',
    description: '',
    version: '1',
    server: 'server.ts',
    apiVersion: 1,
    permissions: { server: true, routes: true },
  }
  const marker = join(dir, 'executed')
  const code = `await Bun.write(${JSON.stringify(marker)}, 'yes'); export default { routes(app) { app.get('/version', c => c.text('one')) } }`
  await Bun.write(join(source, 'manifest.json'), JSON.stringify(manifest))
  await Bun.write(join(source, 'server.ts'), code)
  await git.runGit(['init', '-b', 'main'], source)
  await git.runGit(['config', 'user.email', 'test@example.invalid'], source)
  await git.runGit(['config', 'user.name', 'Test'], source)
  const commit = async (message: string) => {
    await git.runGit(['add', '.'], source)
    await git.runGit(['commit', '-m', message], source)
  }
  await commit('initial')
  try {
    const preview = await git.previewRepository(source)
    await git.confirmInstall(preview.token, false)
    expect(await Bun.file(marker).exists()).toBe(false)
    setSetting('ext:safe', { secret: 'credential' })
    expect(registry.listExtensions().find((e) => e.id === 'safe')?.settings).toEqual({})
    await registry.configureExtension('safe', { enabled: true, approvePermissions: true })
    expect(await Bun.file(marker).text()).toBe('yes')
    const initial = registry.extensionLocation('safe').git!.commit
    await Bun.write(join(source, 'server.ts'), 'throw new Error("broken"); export default {}')
    await commit('broken')
    // 更新副本准备期间触发清理，模拟另一条目录扫描；活动目录不能被回收。
    const fs = await import('node:fs/promises')
    const originalCopy = fs.cp
    let activePreserved = false
    const copying = spyOn(fs, 'cp').mockImplementation(async (source, destination, options) => {
      await originalCopy(source, destination, options)
      if (typeof destination === 'string' && destination.includes('/.update-')) {
        await git.cleanupExtensionStaging()
        activePreserved = await Bun.file(join(destination, 'manifest.json')).exists()
      }
    })
    try {
      await expect(git.updateGitExtension('safe')).rejects.toMatchObject({ code: 'EXTENSION_UPDATE_ROLLED_BACK' })
      expect(activePreserved).toBe(true)
    } finally {
      copying.mockRestore()
    }

    expect(registry.extensionLocation('safe').git!.commit).toBe(initial)
    expect(
      await (await registry.forwardExtension('safe', new Request('http://local/api/ext/safe/version'))).text(),
    ).toBe('one')
    await rm(marker)
    await Bun.write(join(source, 'server.ts'), code)
    await Bun.write(join(source, 'manifest.json'), JSON.stringify({ ...manifest, apiVersion: 999 }))
    await commit('incompatible')
    await expect(git.updateGitExtension('safe')).rejects.toThrow()
    expect(await Bun.file(marker).exists()).toBe(false)
    expect(registry.extensionLocation('safe').git!.commit).toBe(initial)
    await Bun.write(
      join(source, 'manifest.json'),
      JSON.stringify({ ...manifest, permissions: { ...manifest.permissions, background: true } }),
    )
    await commit('new permission')
    const changed = await git.updateGitExtension('safe')
    expect(changed.permissionsChanged).toBe(true)
    expect(changed.extension.needsApproval).toBe(true)
    expect(await Bun.file(marker).exists()).toBe(false)
    await registry.configureExtension('safe', { approvePermissions: true, enabled: true })
    expect(await Bun.file(marker).exists()).toBe(true)
    expect(await Bun.file(join(paths.extensions, 'safe', 'manifest.json')).exists()).toBe(true)
    const stableCommit = registry.extensionLocation('safe').git!.commit
    await Bun.write(
      join(source, 'manifest.json'),
      JSON.stringify({
        ...manifest,
        permissions: { ...manifest.permissions, background: true, network: ['new.example.invalid'] },
      }),
    )
    await Bun.write(join(source, 'server.ts'), 'throw new Error("broken after approval"); export default {}')
    await commit('approval failure')
    expect((await git.updateGitExtension('safe')).extension.needsApproval).toBe(true)
    await expect(
      registry.configureExtension('safe', { approvePermissions: true, enabled: true }),
    ).rejects.toMatchObject({ code: 'EXTENSION_UPDATE_ROLLED_BACK' })
    expect(registry.extensionLocation('safe').git!.commit).toBe(stableCommit)
    expect(registry.listExtensions().find((entry) => entry.id === 'safe')?.enabled).toBe(true)
    // 模拟批准后进程退出：两个入口都失败，必须逐个恢复，不能因首个回滚中断启动。
    const approved = getSetting<Record<string, string>>('extensionsApproved') ?? {}
    const enabled = getSetting<Record<string, boolean>>('extensionsEnabled') ?? {}
    for (const id of ['restart-a', 'restart-b']) {
      const directory = join(paths.extensions, id)
      const backup = join(paths.extensions, `.backup-${crypto.randomUUID()}`)
      await mkdir(directory)
      await Bun.write(join(directory, 'manifest.json'), JSON.stringify({ ...manifest, id }))
      await Bun.write(
        join(directory, 'server.ts'),
        "export default { routes(app) { app.get('/version', c => c.text('restored')) } }",
      )
      await cp(directory, backup, { recursive: true })
      approved[id] = JSON.stringify(['server', 'routes'])
      enabled[id] = true
      setSetting(`extensionRollback:${id}`, { directory, backup, approved: approved[id], enabled: true })
      await Bun.write(join(directory, 'server.ts'), "throw new Error('startup failure'); export default {}")
    }
    setSetting('extensionsApproved', approved)
    setSetting('extensionsEnabled', enabled)
    await registry.unloadUserExtensions()
    await registry.ensureUserExtensions()
    for (const id of ['restart-a', 'restart-b']) {
      expect(getSetting(`extensionRollback:${id}`)).toBeUndefined()
      expect(
        await (await registry.forwardExtension(id, new Request(`http://local/api/ext/${id}/version`))).text(),
      ).toBe('restored')
    }
    const stale = join(paths.extensions, `.update-${crypto.randomUUID()}`)
    const backup = join(paths.extensions, `.backup-${crypto.randomUUID()}`)
    await mkdir(stale)
    await mkdir(backup)
    await Bun.write(join(stale, 'marker'), 'stale')
    await Bun.write(join(backup, 'marker'), 'recovery')
    await git.cleanupExtensionStaging()
    expect(await Bun.file(join(stale, 'marker')).exists()).toBe(false)
    expect(await Bun.file(join(backup, 'marker')).text()).toBe('recovery')
  } finally {
    await registry.unloadUserExtensions()
    await rm(dir, { recursive: true, force: true })
  }
})
