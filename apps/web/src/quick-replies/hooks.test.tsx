import { expect, test } from 'bun:test'
import { quickReplySchema, quickReplySetInput } from '@nobot/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { registerCommand } from '../commands/registry'
import { useCommandDrafts } from '../stores/commandInput'
import { useRunQuickReply } from './hooks'

test('执行 hook 绑定会话，透传组设置，返回结果并传播命令失败', async () => {
  const qc = new QueryClient()
  let run!: ReturnType<typeof useRunQuickReply>
  function Probe() {
    run = useRunQuickReply('qr-hook')
    return null
  }
  renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Probe />
    </QueryClientProvider>,
  )
  const dispose = registerCommand({
    name: 'qr-hook-test',
    description: '',
    args: [],
    run: async (ctx) => {
      if (ctx.getInput() === 'fail') throw new Error('failed')
      return ctx.chatId ?? ''
    },
  })
  try {
    const qr = quickReplySchema.parse({ id: 'button', label: '', message: '/qr-hook-test' })
    expect(await run(qr)).toBe('qr-hook')
    useCommandDrafts.getState().set('qr-hook', 'draft')
    expect(
      await run(
        { ...qr, message: 'Hello {{input}}' },
        {
          ...quickReplySetInput.parse({ name: 'set', buttons: [], disableSend: true }),
          id: 'set',
        },
      ),
    ).toBe('Hello draft')
    expect(useCommandDrafts.getState().drafts['qr-hook']).toBe('Hello draft')
    useCommandDrafts.getState().set('qr-hook', 'fail')
    await expect(run(qr)).rejects.toThrow('failed')
  } finally {
    dispose()
    qc.clear()
    useCommandDrafts.getState().set('qr-hook', '')
  }
})
