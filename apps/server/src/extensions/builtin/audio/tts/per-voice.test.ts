import { expect, test } from 'bun:test'
import type { DeliveryCapabilities } from '@nobot/shared'
import { Hono } from 'hono'
import { deliveryCapabilities } from './delivery'
import { audioSettings } from './settings'

const settings = {
  cosyvoiceApi: 'official',
  cosyvoiceVoices: [
    { id: 'instruction / 中文', mode: 'instruct' },
    { id: 'reference', mode: 'zero_shot' },
    { id: 'speaker', mode: 'sft' },
  ],
}

async function appFor(cosyvoiceApi: string) {
  // 先初始化扩展注册表，避免直接加载路由触发循环依赖。
  await import('../../../registry')
  const { registerTtsRoutes } = await import('./routes')
  const app = new Hono()
  registerTtsRoutes(app, {
    settings: { ...settings, cosyvoiceApi },
    storage: { get: () => undefined, set: () => {}, delete: () => {} },
  })
  return app
}

test('官方模式引擎级能力要求按声音查询，即使存在 instruct 预设', () => {
  const parsed = audioSettings.parse(settings)
  expect(deliveryCapabilities('cosyvoice', parsed)).toMatchObject({ emotion: 'none', perVoice: true })
  expect(deliveryCapabilities('cosyvoice', parsed, 'instruction / 中文')).toMatchObject({
    emotion: 'instruction',
    direction: true,
  })
  for (const voice of ['reference', 'speaker', 'unknown']) {
    expect(deliveryCapabilities('cosyvoice', parsed, voice).emotion).toBe('none')
  }
})

test('引擎路由保留默认列表，按声音返回 instruct 和 zero_shot 的能力', async () => {
  const app = await appFor('official')
  const all = (await (await app.request('/tts/engines')).json()) as { id: string; delivery: DeliveryCapabilities }[]
  expect(all.length).toBeGreaterThan(1)
  expect(all.find((engine) => engine.id === 'cosyvoice')?.delivery).toMatchObject({
    emotion: 'none',
    perVoice: true,
  })
  for (const [voice, emotion] of [
    ['instruction / 中文', 'instruction'],
    ['reference', 'none'],
  ] as const) {
    const response = await app.request(`/tts/engines?${new URLSearchParams({ engine: 'cosyvoice', voice })}`)
    expect(response.status).toBe(200)
    const engines = (await response.json()) as { id: string; delivery: DeliveryCapabilities }[]
    expect(engines).toHaveLength(1)
    expect(engines[0]?.delivery.emotion).toBe(emotion)
    expect(engines[0]?.delivery).not.toHaveProperty('perVoice')
  }
  expect((await app.request('/tts/engines?engine=invalid')).status).toBe(400)
})

test('网关模式引擎及声音能力固定，不包含 perVoice', async () => {
  const app = await appFor('gateway')
  for (const suffix of ['', '&voice=reference']) {
    const response = await app.request(`/tts/engines?engine=cosyvoice${suffix}`)
    const engines = (await response.json()) as { delivery: DeliveryCapabilities }[]
    expect(engines[0]?.delivery).toMatchObject({ emotion: 'instruction', direction: true })
    expect(engines[0]?.delivery).not.toHaveProperty('perVoice')
  }
})
