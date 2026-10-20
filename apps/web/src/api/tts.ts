import type { ChatVoiceConfig, ChatVoiceDTO, TtsEngineId, TtsLineResult, TtsSpeaker, VoiceRef } from '@nobot/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { readError } from './client'

export interface TtsOption {
  value: string
  label: string
  lang?: string
}
export interface TtsSegment {
  speaker: TtsSpeaker
  text: string
  expression?: string
}
async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/ext/audio/tts${path}`, {
    method,
    signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw await readError(response)
  return response.json() as Promise<T>
}
export const ttsApi = {
  chatVoice: (chatId: string, signal?: AbortSignal) =>
    request<ChatVoiceDTO>('GET', `/chat/${encodeURIComponent(chatId)}`, undefined, signal),
  setChatVoice: ({ chatId, config }: { chatId: string; config: ChatVoiceConfig }) =>
    request<ChatVoiceDTO>('PUT', `/chat/${encodeURIComponent(chatId)}`, config),
  resetChatVoice: (chatId: string) => request<ChatVoiceDTO>('DELETE', `/chat/${encodeURIComponent(chatId)}`),
  engines: () => request<{ id: TtsEngineId; label: string; configured: boolean }[]>('GET', '/engines'),
  voices: (engine: TtsEngineId, settings?: Record<string, unknown>, signal?: AbortSignal) =>
    request<{ options: TtsOption[] }>('POST', '/voices', { engine, settings }, signal),
  characterVoice: (id: string) => request<VoiceRef | null>('GET', `/voice/character/${encodeURIComponent(id)}`),
  setCharacterVoice: ({ id, voice }: { id: string; voice: VoiceRef | null }) =>
    request<VoiceRef | null>('PUT', `/voice/character/${encodeURIComponent(id)}`, { voice }),
  line: (input: { chatId: string; speaker: TtsSpeaker; text: string; expression?: string }, signal?: AbortSignal) =>
    request<TtsLineResult>('POST', '/line', input, signal),
  message: (messageId: string, signal?: AbortSignal) =>
    request<{ chatId: string; segments: TtsSegment[] }>('POST', '/message', { messageId }, signal),
  preview: (input: { voice: VoiceRef; text?: string }) => request<TtsLineResult>('POST', '/preview', input),
  cache: () => request<{ bytes: number; files: number }>('GET', '/cache'),
  clearCache: () => request<{ ok: true }>('DELETE', '/cache'),
}
export const useTtsEngines = () => useQuery({ queryKey: ['tts', 'engines'], queryFn: ttsApi.engines })
export function browserVoices(): TtsOption[] {
  return typeof speechSynthesis === 'undefined'
    ? []
    : speechSynthesis.getVoices().map((voice) => ({ value: voice.name, label: voice.name, lang: voice.lang }))
}
export function useTtsVoices(engine: TtsEngineId, settingsDraft?: Record<string, unknown>) {
  const qc = useQueryClient()
  const key = ['tts', 'voices', engine, settingsDraft] as const
  useEffect(() => {
    if (engine !== 'browser' || typeof speechSynthesis === 'undefined') return
    const changed = () => {
      void qc.invalidateQueries({ queryKey: ['tts', 'voices', 'browser'] })
    }
    speechSynthesis.addEventListener('voiceschanged', changed)
    return () => speechSynthesis.removeEventListener('voiceschanged', changed)
  }, [engine, qc])
  return useQuery({
    queryKey: key,
    queryFn: async ({ signal }) =>
      engine === 'browser' ? browserVoices() : (await ttsApi.voices(engine, settingsDraft, signal)).options,
  })
}
export const useCharacterVoice = (id: string) =>
  useQuery({ queryKey: ['tts', 'character', id], queryFn: () => ttsApi.characterVoice(id), enabled: !!id })
export function useSetCharacterVoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ttsApi.setCharacterVoice,
    onSuccess: (_voice, { id }) => {
      void qc.invalidateQueries({ queryKey: ['tts', 'character', id] })
      void qc.invalidateQueries({ queryKey: ['characters'] })
    },
  })
}
export const usePreviewVoice = () => useMutation({ mutationFn: ttsApi.preview })
export const useTtsCache = () => useQuery({ queryKey: ['tts', 'cache'], queryFn: ttsApi.cache })
export function useClearTtsCache() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ttsApi.clearCache,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tts', 'cache'] }),
  })
}

export const useChatVoice = (chatId: string) =>
  useQuery({
    queryKey: ['tts', 'chat', chatId],
    queryFn: ({ signal }) => ttsApi.chatVoice(chatId, signal),
    enabled: !!chatId,
  })
export function useSetChatVoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ttsApi.setChatVoice,
    onSuccess: async (dto, { chatId }) => {
      await qc.cancelQueries({ queryKey: ['tts', 'chat', chatId] })
      await qc.invalidateQueries({ queryKey: ['tts', 'chat', chatId], refetchType: 'none' })
      qc.setQueryData(['tts', 'chat', chatId], dto)
    },
  })
}
export function useResetChatVoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ttsApi.resetChatVoice,
    onSuccess: async (dto, chatId) => {
      await qc.cancelQueries({ queryKey: ['tts', 'chat', chatId] })
      await qc.invalidateQueries({ queryKey: ['tts', 'chat', chatId], refetchType: 'none' })
      qc.setQueryData(['tts', 'chat', chatId], dto)
    },
  })
}
