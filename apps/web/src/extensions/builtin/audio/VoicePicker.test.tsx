import { expect, test } from 'bun:test'
import type { DeliveryCapabilities } from '@nobot/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { VoicePicker } from './VoicePicker'

const base: DeliveryCapabilities = {
  emotion: 'none',
  intensity: false,
  direction: false,
  cues: [],
  volume: false,
}

test('声音能力标签区分未选择、查询中、instruct、zero_shot 和固定网关能力', () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const engines = (delivery: DeliveryCapabilities) => [
    { id: 'cosyvoice', label: 'CosyVoice', configured: true, delivery },
  ]
  const render = (voice: string) =>
    renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <VoicePicker value={{ engine: 'cosyvoice', voice, speed: 1 }} onChange={() => {}} />
      </QueryClientProvider>,
    )
  try {
    qc.setQueryData(['tts', 'engines'], engines({ ...base, perVoice: true }))
    for (const voice of ['', 'pending']) {
      const html = render(voice)
      expect(html).toContain('取决于所选声音的模式')
      expect(html).not.toContain('不支持语气')
    }
    qc.setQueryData(['tts', 'engines', 'cosyvoice', 'instruct'], engines({ ...base, emotion: 'instruction' }))
    expect(render('instruct')).toContain('自然语言指令')
    qc.setQueryData(['tts', 'engines', 'cosyvoice', 'zero'], engines(base))
    expect(render('zero')).toContain('不支持语气')
    qc.setQueryData(['tts', 'engines'], engines({ ...base, emotion: 'instruction' }))
    expect(render('zero')).toContain('自然语言指令')
    expect(render('')).not.toContain('取决于所选声音的模式')
  } finally {
    qc.clear()
  }
})
