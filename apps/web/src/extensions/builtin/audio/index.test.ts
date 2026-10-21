import { expect, spyOn, test } from 'bun:test'
import { playPresetDataSchema } from '@nobot/shared'
import * as React from 'react'
import { api as client } from '../../../api/client'
import { ttsApi } from '../../../api/tts'
import { toast } from '../../../stores/toast'
import { useVnVoiceStore } from '../../../stores/vnVoice'
import type { ClientExtensionAPI } from '../../types'
import activate from './index'
import { ttsPlayer } from './tts-player'
import { useStopTtsOnLeave } from './useStopTtsOnLeave'

for (const directives of [false, true]) {
  test(`逐字订阅群聊 streaming store，生成中即入队完整旁白和引语（舞台指令 ${directives}）`, async () => {
    const { useStreaming } = await import('../../../stores/streaming')
    const { message } = await import('../../../api/hooks.test-utils')
    const handlers = new Map<string, (event: { chatId: string }) => void>()
    let cleanup: (() => void) | undefined
    const effect = spyOn(React, 'useEffect').mockImplementation((callback) => {
      cleanup = callback() || undefined
    })
    const extension = {
      on: (type: string, handler: (event: { chatId: string }) => void) => {
        handlers.set(type, handler)
        return () => {}
      },
      registerPage: () => {},
      registerSlot: () => {},
    } as unknown as ClientExtensionAPI
    const reply = { ...message, id: 'live-group-reply', speakerId: 'alice', content: '', status: 'streaming' as const }
    const pageValue = {
      playPresetId: 'preset',
      messages: [{ ...message, id: 'user', role: 'user' as const }, reply],
    } as Awaited<ReturnType<typeof client.getChatPage>>
    const voice = spyOn(ttsApi, 'chatVoice').mockResolvedValue({
      effective: { enabled: true, autoRead: true, streamRead: true },
      members: [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
      ],
      npcs: [],
    } as unknown as Awaited<ReturnType<typeof ttsApi.chatVoice>>)
    const page = spyOn(client, 'getChatPage').mockResolvedValue(pageValue)
    const presets = spyOn(client, 'listPlayPresets').mockResolvedValue([
      { id: 'preset', data: playPresetDataSchema.parse({ directives: { enabled: directives } }) },
    ] as Awaited<ReturnType<typeof client.listPlayPresets>>)
    const line = spyOn(ttsPlayer, 'enqueueLine').mockImplementation(() => {})
    const whole = spyOn(ttsPlayer, 'enqueueMessage').mockImplementation(() => {})
    let deactivate: Awaited<ReturnType<typeof activate>>
    const append = async (text: string) => {
      for (const char of text) {
        useStreaming.getState().append(char, '')
        await flush()
      }
    }
    try {
      deactivate = await activate(extension)
      useStopTtsOnLeave('chat')
      handlers.get('generation:start')!({ chatId: 'chat' })
      useStreaming.getState().begin('chat', reply.id)
      await append('她望着雨幕。')
      expect(line).not.toHaveBeenCalled()
      await append('「')
      expect(useStreaming.getState().messageId).toBe(reply.id)
      expect(line.mock.calls.map((call) => call[1].text)).toEqual(['她望着雨幕。'])
      await append('雨天像一首安静的诗」')
      expect(line).toHaveBeenCalledTimes(1)
      await append('。')
      expect(useStreaming.getState().messageId).toBe(reply.id)
      expect(line.mock.calls.map((call) => call[1].text)).toEqual(['她望着雨幕。', '雨天像一首安静的诗'])
      expect(line.mock.calls[1]?.[1].speaker).toEqual({ kind: 'character', characterId: 'alice' })
      pageValue.messages[1] = { ...reply, content: useStreaming.getState().text, status: 'done' }
      useStreaming.getState().end()
      handlers.get('generation:complete')!({ chatId: 'chat' })
      await flush()
      await flush()
      expect(line.mock.calls.map((call) => call[1].text)).toEqual(['她望着雨幕。', '雨天像一首安静的诗', '。'])
      expect(whole).not.toHaveBeenCalled()
      // 设置与消息身份只需在首个快照取回，逐字增长直接沿用同一上下文。
      expect(page.mock.calls.length).toBeLessThanOrEqual(4)
    } finally {
      cleanup?.()
      if (typeof deactivate === 'function') deactivate()
      useStreaming.getState().end()
      effect.mockRestore()
      voice.mockRestore()
      page.mockRestore()
      presets.mockRestore()
      line.mockRestore()
      whole.mockRestore()
    }
  })
}

const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve()
}

test('自动朗读只在当前聊天视图播放，各阶段切走或切走再回来均取消旧请求', async () => {
  let cleanup: (() => void) | undefined
  const effect = spyOn(React, 'useEffect').mockImplementation((callback) => {
    cleanup = callback() || undefined
  })
  let complete!: (event: { type: 'generation:complete'; chatId: string }) => void
  const extension = {
    on: (_type: string, handler: typeof complete) => {
      complete = handler
      return () => {}
    },
    registerPage: () => {},
    registerSlot: () => {},
  } as unknown as ClientExtensionAPI
  const pageValue = { playPresetId: 'preset', messages: [{ id: 'message', role: 'assistant' }] } as Awaited<
    ReturnType<typeof client.getChatPage>
  >
  const voiceValue = { effective: { enabled: true, autoRead: true } } as Awaited<ReturnType<typeof ttsApi.chatVoice>>
  const voice = spyOn(ttsApi, 'chatVoice').mockResolvedValue(voiceValue)
  const page = spyOn(client, 'getChatPage').mockResolvedValue(pageValue)
  const presets = spyOn(client, 'listPlayPresets').mockResolvedValue([])
  const toastError = spyOn(toast, 'error').mockImplementation(() => {})
  const speak = spyOn(ttsPlayer, 'enqueueMessage').mockImplementation(() => {})
  let deactivate: Awaited<ReturnType<typeof activate>>
  const leave = () => {
    cleanup?.()
    cleanup = undefined
  }
  try {
    deactivate = await activate(extension)
    useStopTtsOnLeave('a')
    complete({ type: 'generation:complete', chatId: 'other' })
    expect(voice).not.toHaveBeenCalled()
    complete({ type: 'generation:complete', chatId: 'a' })
    await flush()
    expect(speak).toHaveBeenLastCalledWith('a', 'message')
    pageValue.messages[0]!.id = 'second'
    speak.mockImplementationOnce(() => {
      throw new Error('自动朗读失败')
    })
    complete({ type: 'generation:complete', chatId: 'a' })
    await flush()
    expect(useVnVoiceStore.getState().lastVoiceError?.message).toBe('自动朗读失败')
    expect(toastError).not.toHaveBeenCalled()
    speak.mockClear()
    for (const stage of ['voice', 'page', 'presets'] as const) {
      for (const returnToSameChat of [false, true]) {
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        if (stage === 'voice')
          voice.mockImplementationOnce(async () => {
            await gate
            return voiceValue
          })
        if (stage === 'page')
          page.mockImplementationOnce(async () => {
            await gate
            return pageValue
          })
        if (stage === 'presets')
          presets.mockImplementationOnce(async () => {
            await gate
            return []
          })
        complete({ type: 'generation:complete', chatId: 'a' })
        await flush()
        leave()
        useStopTtsOnLeave(returnToSameChat ? 'a' : 'b')
        release()
        await flush()
        expect(speak).not.toHaveBeenCalled()
        leave()
        useStopTtsOnLeave('a')
      }
    }
    complete({ type: 'generation:complete', chatId: 'a' })
    leave()
    await flush()
    expect(speak).not.toHaveBeenCalled()
  } finally {
    leave()
    if (typeof deactivate === 'function') deactivate()
    effect.mockRestore()
    voice.mockRestore()
    page.mockRestore()
    presets.mockRestore()
    speak.mockRestore()
    toastError.mockRestore()
    useVnVoiceStore.setState({ lastVoiceError: null })
  }
})

test('群聊逐条流式完成补尾，整轮 complete 不重复；普通自动朗读收齐两条回复', async () => {
  const { useStreaming } = await import('../../../stores/streaming')
  const { message } = await import('../../../api/hooks.test-utils')
  const handlers = new Map<string, (event: { chatId: string }) => void>()
  let cleanup: (() => void) | undefined
  const effect = spyOn(React, 'useEffect').mockImplementation((callback) => {
    cleanup = callback() || undefined
  })
  const extension = {
    on: (type: string, handler: (event: { chatId: string }) => void) => {
      handlers.set(type, handler)
      return () => {}
    },
    registerPage: () => {},
    registerSlot: () => {},
  } as unknown as ClientExtensionAPI
  const messages = [
    { ...message, id: 'user', role: 'user' as const },
    { ...message, id: 'one', content: '旁白「Hi」尾声' },
    { ...message, id: 'two', content: '旁白「Hello」结束' },
  ]
  const pageValue = { playPresetId: 'preset', messages } as Awaited<ReturnType<typeof client.getChatPage>>
  const voice = spyOn(ttsApi, 'chatVoice').mockResolvedValue({
    effective: { enabled: true, autoRead: true, streamRead: true },
    members: [],
  } as unknown as Awaited<ReturnType<typeof ttsApi.chatVoice>>)
  const page = spyOn(client, 'getChatPage').mockResolvedValue(pageValue)
  const presets = spyOn(client, 'listPlayPresets').mockResolvedValue([])
  const line = spyOn(ttsPlayer, 'enqueueLine').mockImplementation(() => {})
  const whole = spyOn(ttsPlayer, 'enqueueMessage').mockImplementation(() => {})
  let deactivate: Awaited<ReturnType<typeof activate>>
  try {
    deactivate = await activate(extension)
    useStopTtsOnLeave('chat')
    handlers.get('generation:start')!({ chatId: 'chat' })
    useStreaming.getState().begin('chat', 'one')
    useStreaming.getState().append(messages[1]!.content, '')
    await flush()
    await flush()
    expect(line.mock.calls.map((c) => c[1].text)).toEqual(['旁白', 'Hi'])
    useStreaming.getState().end()
    useStreaming.getState().begin('chat', 'two')
    useStreaming.getState().append(messages[2]!.content, '')
    await flush()
    await flush()
    useStreaming.getState().end()
    handlers.get('generation:complete')!({ chatId: 'chat' })
    await flush()
    await flush()
    expect(line.mock.calls.map((c) => c[1].text)).toEqual(['旁白', 'Hi', '尾声', '旁白', 'Hello', '结束'])
    expect(whole).not.toHaveBeenCalled()
    cleanup?.()
    if (typeof deactivate === 'function') deactivate()
    voice.mockResolvedValue({
      effective: { enabled: true, autoRead: true, streamRead: false },
      members: [],
    } as unknown as Awaited<ReturnType<typeof ttsApi.chatVoice>>)
    deactivate = await activate(extension)
    useStopTtsOnLeave('chat')
    handlers.get('generation:complete')!({ chatId: 'chat' })
    await flush()
    handlers.get('generation:complete')!({ chatId: 'chat' })
    await flush()
    expect(whole.mock.calls).toEqual([
      ['chat', 'one'],
      ['chat', 'two'],
    ])
  } finally {
    cleanup?.()
    if (typeof deactivate === 'function') deactivate()
    useStreaming.getState().end()
    effect.mockRestore()
    voice.mockRestore()
    page.mockRestore()
    presets.mockRestore()
    line.mockRestore()
    whole.mockRestore()
  }
})
