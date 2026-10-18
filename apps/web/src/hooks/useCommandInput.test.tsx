import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { registerCommand } from '../commands/registry'
import { useCommandInput } from './useCommandInput'

function input(text: string) {
  let result!: ReturnType<typeof useCommandInput>
  const qc = new QueryClient()
  function Probe() {
    result = useCommandInput(text)
    return null
  }
  renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Probe />
    </QueryClientProvider>,
  )
  qc.clear()
  return result
}

test('命令名输入、精确命令与别名、参数阶段和普通输入', () => {
  expect(input('/').typing).toBe(true)
  expect(input('/rol').command).toBeUndefined()
  expect(input('/roll').typing).toBe(true)
  expect(input('/roll ').command?.name).toBe('roll')
  expect(input('/rollX ').command).toBeUndefined()
  expect(input('/roll! ').command).toBeUndefined()
  const dispose = registerCommand({
    name: 'g-test',
    aliases: ['g-alias'],
    description: '',
    args: [],
    run: async () => '',
  })
  try {
    expect(input('/g-alias ').command?.name).toBe('g-test')
  } finally {
    dispose()
  }
  expect(input('hello /roll').typing).toBe(false)
  expect(input('/echo one | /rol').typing).toBe(true)
  expect(input('/echo one | /roll 1d20').command?.name).toBe('roll')
})

test('补全只替换最后一段，保留管道、引号、转义和参数', () => {
  expect(input('/rol').complete('roll')).toBe('/roll ')
  expect(input(' /echo "a|b"  |  /rol').complete('roll')).toBe(' /echo "a|b"  |  /roll ')
  expect(input('/echo a\\|b | /rol 1d20').complete('roll')).toBe('/echo a\\|b | /roll 1d20')
  expect(input('hello').complete('roll')).toBe('hello')
  expect(input('/echo "unfinished').complete('roll')).toBe('/echo "unfinished')
})
