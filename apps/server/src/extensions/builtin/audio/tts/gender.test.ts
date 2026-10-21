import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatVoiceDTO, VoiceRef } from '@nobot/shared'
import { Hono } from 'hono'
import type { ExtensionStorage } from '../../../types'

test('性别推断、优先级、缓存失效、异步分配和双会话 DTO 隔离', async () => {
  if (!process.env.TTS_GENDER_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, TTS_GENDER_CHILD: '1' },
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
  const directory = await mkdtemp(join(tmpdir(), 'nobot-gender-'))
  process.env.DATA_DIR = directory
  await (await import('../../../../bootstrap')).bootstrap()
  const { sqlite } = await import('../../../../db/client')
  const { createCharacter, updateCharacter } = await import('../../../../services/characters')
  const { createChat } = await import('../../../../services/chats')
  const { writeTemporaryActor } = await import('../../../../services/temporary-actors')
  const { inferGender, readGender, parseGender, waitForGender } = await import('./gender')
  const { poolVoice, resolveVoice, resolveVoiceSync } = await import('./service')
  const { audioSettings } = await import('./settings')
  const { registerTtsRoutes } = await import('./routes')
  const data = new Map<string, unknown>()
  const storage: ExtensionStorage = {
    get: <T>(key: string) => data.get(key) as T | undefined,
    set: (key, value) => {
      data.set(key, value)
    },
    delete: (key) => {
      data.delete(key)
    },
  }
  try {
    const alice = createCharacter({ name: 'Alice', description: 'A traveler', personality: 'Kind' })
    const b = createCharacter({ name: 'B' })
    const aChat = createChat({ characterId: alice.id })
    const bChat = createChat({ characterId: b.id })
    const speaker = { kind: 'character' as const, characterId: alice.id }
    const female: VoiceRef = { engine: 'openai', voice: 'nova', speed: 1 }
    const male: VoiceRef = { engine: 'openai', voice: 'ash', speed: 1 }
    const neutral: VoiceRef = { engine: 'openai', voice: 'alloy', speed: 1 }
    const unknown: VoiceRef = { engine: 'fish', voice: 'opaque', speed: 1 }
    const pool = [male, female, neutral, unknown]
    expect(poolVoice('Alice', pool, 'female')).toEqual(female)
    expect(poolVoice('Alice', pool, 'male')).toEqual(male)
    expect(poolVoice('Alice', pool, 'other')).toEqual(neutral)
    expect(poolVoice('Alice', [male, unknown], 'female')).toEqual(poolVoice('Alice', [male, unknown]))
    expect(poolVoice('Alice', [male, unknown], 'other')).toEqual(poolVoice('Alice', [male, unknown]))
    expect(poolVoice('Alice', [{ ...male, gender: 'female' }], 'female')?.gender).toBe('female')
    expect(parseGender('It is FEMALE, not male')).toBe('female')
    expect(parseGender('女性')).toBeUndefined()
    expect(parseGender('human')).toBeUndefined()
    let calls = 0
    let release = (_: string) => {}
    const prompts: { instruction: string; includeHistory?: boolean }[] = []
    const ctx = {
      storage,
      host: {
        quietPrompt: async (opts: { instruction: string; includeHistory?: boolean }) => {
          calls++
          prompts.push(opts)
          return new Promise<string>((resolve) => {
            release = resolve
          })
        },
      },
    }
    const first = inferGender(ctx, aChat.id, speaker)
    expect(inferGender(ctx, bChat.id, speaker)).toBe(first)
    expect(calls).toBe(1)
    expect(await waitForGender(first, 1)).toBeUndefined()
    release('female')
    expect(await first).toBe('female')
    expect(await inferGender(ctx, aChat.id, speaker)).toBe('female')
    expect(calls).toBe(1)
    expect(await inferGender(ctx, aChat.id, { kind: 'npc', name: 'Disabled' }, undefined, false)).toBeUndefined()
    expect(calls).toBe(1)
    expect(prompts[0]?.includeHistory).toBe(false)
    expect(prompts[0]?.instruction).toContain('A traveler')
    expect(readGender(storage, aChat.id, speaker)).toEqual({ gender: 'female', genderSource: 'inferred' })
    expect(readGender(storage, aChat.id, speaker, undefined, false).gender).toBeNull()
    updateCharacter(alice.id, { description: 'Changed' })
    expect(readGender(storage, aChat.id, speaker).gender).toBeNull()
    const next = inferGender(ctx, aChat.id, speaker)
    release('male')
    await next
    expect(calls).toBe(2)
    updateCharacter(alice.id, { extensions: { nobot_gender: 'other' } })
    expect(readGender(storage, aChat.id, speaker).genderSource).toBe('card')
    const config = { characters: {}, npcs: {}, genders: { [alice.id]: 'female' as const } }
    expect(readGender(storage, aChat.id, speaker, config)).toEqual({ gender: 'female', genderSource: 'chat' })
    const settings = { ...audioSettings.parse({ npcVoices: pool }), chatVoice: config }
    expect(await resolveVoice(aChat.id, speaker, settings, ctx)).toEqual(female)
    expect(resolveVoiceSync(aChat.id, speaker, { ...settings, genderMatch: false }, ctx)).toEqual(
      poolVoice('Alice', pool)!,
    )
    expect(
      await resolveVoice(
        aChat.id,
        speaker,
        { ...settings, chatVoice: { ...config, characters: { [alice.id]: male } } },
        ctx,
      ),
    ).toEqual(male)
    const npc = { kind: 'npc' as const, name: 'Guard' }
    const npcTask = inferGender(ctx, aChat.id, npc)
    expect(prompts.at(-1)?.includeHistory).toBe(true)
    release('other')
    await npcTask
    expect(data.has(`gender:npc:${aChat.id}:guard`)).toBe(true)
    expect(readGender(storage, bChat.id, npc).gender).toBeNull()
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const failCtx = {
        storage,
        host: {
          quietPrompt: async () => {
            throw new Error('offline')
          },
        },
      }
      expect(await inferGender(failCtx, aChat.id, { kind: 'npc', name: 'Failure' })).toBeUndefined()
      expect(await resolveVoice(aChat.id, { kind: 'npc', name: 'Failure' }, settings, failCtx)).toEqual(
        poolVoice('Failure', pool)!,
      )
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
    // 批量接口使用注入的假模型，检查并发上限与当前会话候选范围。
    for (const name of ['Guard', 'Merchant', 'Visitor'])
      writeTemporaryActor(aChat.id, name.toLowerCase(), {
        key: name.toLowerCase(),
        name,
        image: null,
        prompt: '',
        status: 'done',
        updatedAt: 0,
      })
    let active = 0
    let maximum = 0
    const app = new Hono()
    registerTtsRoutes(app, {
      storage,
      settings,
      host: {
        quietPrompt: async () => {
          maximum = Math.max(maximum, ++active)
          await Bun.sleep(5)
          active--
          return 'female'
        },
      },
    })
    const before = (await (await app.request(`/tts/chat/${aChat.id}`)).json()) as ChatVoiceDTO
    expect(before.members[0]).toMatchObject({ gender: 'other', genderSource: 'card', fallbackVoice: neutral })
    const response = await app.request(`/tts/chat/${aChat.id}/infer-genders`, { method: 'POST' })
    expect(response.status).toBe(200)
    const dto = (await response.json()) as ChatVoiceDTO
    expect(maximum).toBe(2)
    expect(dto.npcs.find((n) => n.key === 'merchant')).toMatchObject({
      gender: 'female',
      genderSource: 'inferred',
      fallbackVoice: female,
    })
    const other = (await (await app.request(`/tts/chat/${bChat.id}`)).json()) as ChatVoiceDTO
    expect(other.members.map((m) => m.id)).toEqual([b.id])
    expect(other.npcs).toEqual([])
  } finally {
    sqlite.close()
    await rm(directory, { recursive: true, force: true })
  }
})
