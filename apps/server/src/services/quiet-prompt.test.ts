import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 延迟加载的服务单例交给既有集成测试隔离；这里仅验证消息角色策略。
test('静默指令角色：无对话时 user，有历史时 system，显式指定优先', async () => {
  if (!process.env.QUIET_ROLE_CHILD) {
    const directory = await mkdtemp(join(tmpdir(), 'nobot-quiet-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        env: { ...process.env, QUIET_ROLE_CHILD: '1', DATA_DIR: directory },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, `${out}\n${err}`).toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    return
  }
  const { paths } = await import('../env')
  paths.db = ':memory:'
  const { instructionRole } = await import('./quiet-prompt')
  expect(instructionRole([])).toBe('user')
  expect(instructionRole([{ role: 'system' }])).toBe('user')
  expect(instructionRole([{ role: 'system' }, { role: 'user' }])).toBe('system')
  expect(instructionRole([{ role: 'assistant' }])).toBe('system')
  expect(instructionRole([], 'system')).toBe('system')
  expect(instructionRole([{ role: 'assistant' }], 'user')).toBe('user')
})
