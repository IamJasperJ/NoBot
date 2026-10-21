import { expect, test } from 'bun:test'
import type { ChatVoiceConfig, VoiceRef } from '@nobot/shared'
import { mergeChatVoiceDraft } from './chat-voice-draft'

test('复用组件切换 A → B：未完成的 NPC、角色和旁白草稿不能进入 B', () => {
  const voice: VoiceRef = { engine: 'edge', voice: '', speed: 1 }
  const a: ChatVoiceConfig = { characters: { alice: voice }, npcs: { bob: voice }, narratorVoice: voice }
  const b: ChatVoiceConfig = { characters: {}, npcs: {} }
  expect(mergeChatVoiceDraft({ chatId: 'A', config: a }, 'B', b)).toEqual({ chatId: 'B', config: b })
  const refresh = mergeChatVoiceDraft({ chatId: 'A', config: a }, 'A', b)
  expect(refresh.config?.npcs.bob).toEqual(voice)
  expect(refresh.config?.characters.alice).toEqual(voice)
  expect(refresh.config?.narratorVoice).toEqual(voice)
  expect(mergeChatVoiceDraft(refresh, 'B', b).config?.npcs).toEqual({})
})
