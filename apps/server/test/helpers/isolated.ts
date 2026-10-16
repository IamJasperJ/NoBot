import { expect, test } from 'bun:test'

/** 数据库和扩展注册表是模块单例，逐场景隔离也避免关闭 CRUD 测试使用的连接。 */
export function isolatedTest(name: string, run: () => Promise<void>) {
  test(name, async () => {
    if (process.env.GENERATION_TEST_CASE === name) return run()
    const child = Bun.spawn(
      [process.execPath, 'test', 'apps/server/test/generation.test.ts', '--test-name-pattern', `^${name}$`],
      {
        env: { ...process.env, GENERATION_TEST_CASE: name },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const deadline = setTimeout(() => child.kill(), 10000)
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, `${stdout}\n${stderr}`).toBe(0)
    } finally {
      clearTimeout(deadline)
    }
  }, 15000)
}
