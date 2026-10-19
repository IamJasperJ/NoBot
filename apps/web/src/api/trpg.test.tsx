import { expect, spyOn, test } from 'bun:test'
import { type CheckResult, playPresetDataSchema } from '@nobot/shared'
import * as React from 'react'
import { registerFreshMessage, useFreshMessages } from '../stores/freshMessages'
import { message, setupHooks } from './hooks.test-utils'
import { keys } from './queries'
import { useFreshDice, usePickChoice, useTrpgSettings } from './trpg'

test('跑团 hooks：预设开关、检定等待、透传、新消息与错误恢复', async () => {
  if (!process.env.TRPG_HOOK_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, TRPG_HOOK_TEST_CHILD: '1' },
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
  const { qc, render, page } = setupHooks()
  const play = playPresetDataSchema.parse({ directives: { enabled: true }, trpg: { diceAnimation: false } })
  const preset = () => qc.setQueryData(keys.playPresets, [{ id: 'play', data: play }])
  const check: CheckResult = {
    who: '玩家',
    skill: 'perception',
    kind: 'skill',
    ability: 'wis',
    dc: 12,
    roll: { expression: '1d20', groups: [], modifier: 0, total: 15 },
    bonus: 0,
    total: 15,
    success: true,
    margin: 3,
    outcome: 'success',
    source: 'none',
  }
  const requests: { url: string; body: Record<string, unknown> }[] = []
  let fail = false
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input)
        requests.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
        if (url.endsWith('/check'))
          return fail
            ? Response.json({ error: { code: 'CHECK', message: '检定失败' } }, { status: 400 })
            : Response.json(check)
        if (url.endsWith('/generate')) {
          const events = [
            { type: 'done', message },
            { type: 'message', message: { ...message, id: 'tool', role: 'tool', parentId: message.id } },
            { type: 'complete' },
          ]
          return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
        }
        return Response.json(page)
      },
      { preconnect: fetch.preconnect },
    ),
  )
  globalThis.cancelAnimationFrame = () => {}
  const cancel = spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
  const effects = spyOn(React, 'useEffect')
  try {
    expect(render(() => useTrpgSettings(null)).enabled).toBe(false)
    expect(render(() => useTrpgSettings('chat')).enabled).toBe(false)
    preset()
    expect(render(() => useTrpgSettings('chat'))).toEqual({
      enabled: true,
      diceAnimation: false,
      diceMs: 800,
      showDc: true,
      initiativeBar: true,
    })
    const option = { text: '观察', check: { skill: 'perception', dc: 12 } }
    const pick = render(() => usePickChoice('chat'))
    await Promise.all([pick.pick(option), pick.pick(option)])
    expect(requests.filter((r) => r.url.endsWith('/check'))).toHaveLength(1)
    expect(requests.find((r) => r.url.endsWith('/generate'))?.body).toEqual({
      mode: 'send',
      text: option.text,
      images: [],
      check,
    })
    expect(render(() => useFreshDice('reply', 800))).toBe(true)
    expect(render(() => useFreshDice('tool', 800))).toBe(true)
    expect(render(() => useFreshDice('history', 800))).toBe(false)
    expect(render(() => useFreshDice('', 800))).toBe(false)
    const now = spyOn(Date, 'now').mockReturnValue(Date.now() + 1000)
    expect(render(() => useFreshDice('reply', 800))).toBe(false)
    now.mockRestore()
    requests.length = 0
    play.trpg.choiceRollClient = false
    preset()
    await render(() => usePickChoice('chat')).pick(option)
    expect(requests.some((r) => r.url.endsWith('/check'))).toBe(false)
    expect(requests.find((r) => r.url.endsWith('/generate'))?.body.check).toBeUndefined()
    play.trpg.choiceRollClient = true
    play.directives.enabled = false
    preset()
    requests.length = 0
    await render(() => usePickChoice('chat')).pick(option)
    expect(requests.some((r) => r.url.endsWith('/check'))).toBe(false)
    play.directives.enabled = true
    play.trpg.ruleSystem = 'coc7'
    preset()
    expect(render(() => useTrpgSettings('chat')).enabled).toBe(false)
    requests.length = 0
    await render(() => usePickChoice('chat')).pick(option)
    expect(requests.some((r) => r.url.endsWith('/check'))).toBe(false)
    play.trpg.ruleSystem = 'dnd5e'
    preset()
    requests.length = 0
    await render(() => usePickChoice('chat')).pick({ text: '直接继续' })
    expect(requests.some((r) => r.url.endsWith('/check'))).toBe(false)
    fail = true
    const retry = render(() => usePickChoice('chat'))
    await expect(retry.pick(option)).rejects.toMatchObject({ code: 'CHECK' })
    fail = false
    await retry.pick(option)
    // 动画等待使用预设时长，并在等待期间阻止重复点选。
    play.trpg.diceAnimation = true
    play.trpg.diceMs = 0
    preset()
    requests.length = 0
    const animated = render(() => usePickChoice('chat'))
    const timer = spyOn(globalThis, 'setTimeout')
    const sending = animated.pick(option)
    await Bun.sleep(10)
    expect(timer.mock.calls.some((call) => call[1] === 900)).toBe(true)
    expect(requests.some((r) => r.url.endsWith('/generate'))).toBe(false)
    await animated.pick(option)
    await sending
    timer.mockRestore()
    registerFreshMessage('expire')
    effects.mockClear()
    expect(render(() => useFreshDice('expire', 50))).toBe(true)
    const cleanup = effects.mock.calls.at(-1)?.[0]()
    await Bun.sleep(65)
    expect(render(() => useFreshDice('expire', 50))).toBe(false)
    if (typeof cleanup === 'function') cleanup()
  } finally {
    effects.mockRestore()
    cancel.mockRestore()
    fetchMock.mockRestore()
    useFreshMessages.setState({ completedAt: new Map() })
    qc.clear()
  }
})
