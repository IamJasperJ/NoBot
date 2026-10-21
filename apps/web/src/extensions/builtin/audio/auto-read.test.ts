import { expect, spyOn, test } from 'bun:test'
import { message } from '../../../api/hooks.test-utils'
import { AutoReader } from './auto-read'
import { ttsPlayer } from './tts-player'

test('流式逐段入队，完成后只补尾段，同轮其他回复继续排队', () => {
  const line = spyOn(ttsPlayer, 'enqueueLine').mockImplementation(() => {})
  const whole = spyOn(ttsPlayer, 'enqueueMessage').mockImplementation(() => {})
  const reader = new AutoReader()
  try {
    const first = { ...message, content: '旁白「Hello」尾声' }
    reader.read('chat', first, [], true, true)
    reader.read('chat', first, [], true, true)
    expect(line.mock.calls.map((c) => c[1].text)).toEqual(['旁白', 'Hello'])
    reader.read('chat', first, [], false, true)
    reader.read('chat', first, [], false, true)
    expect(line.mock.calls.map((c) => c[1].text)).toEqual(['旁白', 'Hello', '尾声'])
    expect(whole).not.toHaveBeenCalled()
    reader.read('chat', { ...first, id: 'second' }, [], false, false)
    reader.read('chat', { ...first, id: 'second' }, [], false, false)
    expect(whole.mock.calls).toEqual([['chat', 'second']])
  } finally {
    line.mockRestore()
    whole.mockRestore()
  }
})

test('关闭流式朗读时等待整条完成，短回复没有完整分段也只补一次', () => {
  const line = spyOn(ttsPlayer, 'enqueueLine').mockImplementation(() => {})
  const whole = spyOn(ttsPlayer, 'enqueueMessage').mockImplementation(() => {})
  try {
    const reader = new AutoReader()
    reader.read('chat', message, [], true, false)
    expect(line).not.toHaveBeenCalled()
    expect(whole).not.toHaveBeenCalled()
    reader.read('chat', message, [], false, false)
    expect(whole).toHaveBeenCalledTimes(1)
    const short = { ...message, id: 'short' }
    reader.read('chat', short, [], true, true)
    reader.read('chat', short, [], false, true)
    expect(line).toHaveBeenCalledTimes(1)
    expect(whole).toHaveBeenCalledTimes(1)
  } finally {
    line.mockRestore()
    whole.mockRestore()
  }
})

test('舞台旁白按预设拆拍后，完成事件仍沿用相同分段位置', async () => {
  const { parseStageMessage } = await import('@nobot/core/stage')
  const line = spyOn(ttsPlayer, 'enqueueLine').mockImplementation(() => {})
  const whole = spyOn(ttsPlayer, 'enqueueMessage').mockImplementation(() => {})
  const reader = new AutoReader()
  const staged = (content: string) => ({
    ...message,
    content,
    meta: {
      stage: parseStageMessage(content, { knownNames: [], vars: {}, inline: false, mvu: false, narrationSplit: 4 })
        .stage,
    },
  })
  try {
    reader.read('chat', staged('甲乙丙。丁戊己。末句'), [], true, true)
    reader.read('chat', staged('甲乙丙。丁戊己。末句。'), [], false, true)
    reader.read('chat', staged('甲乙丙。丁戊己。末句。'), [], false, true)
    expect(line.mock.calls.map((call) => call[1].text)).toEqual(['甲乙丙。', '丁戊己。', '末句。'])
    expect(whole).not.toHaveBeenCalled()
  } finally {
    line.mockRestore()
    whole.mockRestore()
  }
})
