import { expect, spyOn, test } from 'bun:test'
import * as React from 'react'
import { api as client } from '../../../api/client'
import { ttsApi } from '../../../api/tts'
import { toast } from '../../../stores/toast'
import { useVnVoiceStore } from '../../../stores/vnVoice'
import type { ClientExtensionAPI } from '../../types'
import activate from './index'
import { ttsPlayer } from './tts-player'
import { useStopTtsOnLeave } from './useStopTtsOnLeave'

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
  const speak = spyOn(ttsPlayer, 'speakMessage').mockResolvedValue(undefined)
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
    expect(speak).toHaveBeenLastCalledWith('message', 'a')
    speak.mockRejectedValueOnce(new Error('自动朗读失败'))
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
