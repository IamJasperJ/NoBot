import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LiveEnvelope } from '@nobot/shared'

// 独立进程确保两套真实用户库与系统库不受其他测试的全局上下文影响。
test('MP2 房间：双用户隔离、邀请同意、权限、回合与 live', async () => {
  if (!process.env.MP2_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, MP2_TEST_CHILD: '1' },
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
  delete (globalThis as typeof globalThis & { __NOBOT_TEST_USER__?: string }).__NOBOT_TEST_USER__
  const directory = await mkdtemp(join(tmpdir(), 'nobot-rooms-'))
  process.env.DATA_DIR = directory
  const { systemDatabase } = await import('../src/db/system-client')
  const { users, rooms, roomInvites, roomMembers } = await import('../src/db/system-schema')
  const { db, newId } = await import('../src/db/client')
  const { characters, personas, roomEvents, messages, chats } = await import('../src/db/schema')
  const { runAsUser, closeUserDatabase } = await import('../src/user-context')
  const { createServer } = await import('../src/server')
  const { sessions } = await import('../src/db/system-schema')
  const { hashToken } = await import('../src/services/auth')
  const r = await import('../src/services/rooms')
  const turns = await import('../src/services/rooms/turns')
  const { dispatchScope } = await import('../src/services/rooms/scope')
  const { createChat } = await import('../src/services/chats')
  const social = await import('../src/services/social')
  const { eq, lt } = await import('drizzle-orm')
  const { roomPermissions, createRoomInput, roomInviteInput, roomJoinInput, roomSendInput, updateRoomInput } =
    await import('@nobot/shared')
  const { liveHub } = await import('../src/services/live/hub')
  const { loadGenerationContext, toHistory, assemble } = await import('../src/services/generation/context')
  const { multiplayerPrompt } = await import('../src/services/rooms/prompt')
  const now = Date.now()
  const alice = { id: 'alice', handle: 'alice', name: 'Alice', isAdmin: true }
  const bob = { id: 'bob', handle: 'bob', name: 'Bob', isAdmin: false }
  const dave = { id: 'dave', handle: 'dave', name: 'Dave', isAdmin: false }
  const carol = { id: 'carol', handle: 'carol', name: 'Carol', isAdmin: false }
  for (const u of [alice, bob, carol, dave])
    systemDatabase()
      .insert(users)
      .values({ ...u, passwordHash: 'unused', createdAt: now })
      .run()
  const setup = (user: typeof alice) =>
    runAsUser(user, () => {
      const characterId = newId(),
        personaId = newId()
      db.insert(characters)
        .values({
          id: characterId,
          name: `${user.name} AI`,
          description: 'PRIVATE CARD',
          firstMes: 'Welcome',
          createdAt: now,
          updatedAt: now,
        })
        .run()
      db.insert(personas)
        .values({
          id: personaId,
          name: user.name,
          description: `${user.name} public persona`,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      return { characterId, personaId, chat: createChat({ characterId }) }
    })
  try {
    const a = setup(alice),
      b = setup(bob),
      c = setup(carol),
      d = setup(dave)
    const room = runAsUser(alice, () =>
      r.createRoom(
        createRoomInput.parse({
          chatId: a.chat.id,
          name: 'Room',
          personaId: a.personaId,
          turnMode: 'host',
          maxMembers: 2,
        }),
      ),
    )
    const id = room.id
    const otherHostChat = runAsUser(alice, () => createChat({ characterId: a.characterId }))
    const owner = <T>(fn: () => T) => runAsUser(alice, fn)
    const guest = <T>(fn: () => T) => runAsUser(bob, fn)
    const third = <T>(fn: () => T) => runAsUser(carol, fn)
    const scope = (path: string, method = 'GET', body?: unknown) =>
      guest(() =>
        dispatchScope(
          id,
          new Request(`http://local/api/rooms/${id}/scope${path}`, {
            method,
            ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
          }),
          path,
        ),
      )
    const sharp = (await import('sharp')).default
    const image = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ffffff' } })
      .png()
      .toBuffer()
    const { saveAvatar, thumbFile } = await import('../src/lib/files')
    const { saveSprite } = await import('../src/services/sprites/sprites')
    const { saveBackground } = await import('../src/services/backgrounds/backgrounds')
    const { saveAttachment } = await import('../src/services/attachments')
    const avatar = await owner(() => saveAvatar(a.characterId, image))
    owner(() => db.update(characters).set({ avatarFile: avatar }).where(eq(characters.id, a.characterId)).run())
    const guestAvatar = await guest(() => saveAvatar(b.personaId, image))
    guest(() => db.update(personas).set({ avatarFile: guestAvatar }).where(eq(personas.id, b.personaId)).run())
    const sprite = await owner(() => saveSprite(a.characterId, image, '', 'neutral'))
    const background = await owner(() =>
      saveBackground(image, { name: 'Room background', source: 'upload', chatId: a.chat.id }),
    )
    const privateBackground = await owner(() => saveBackground(image, { name: 'Private background', source: 'upload' }))
    const privateAttachment = await owner(() => saveAttachment(image))
    expect(room.members[0]?.role).toBe('owner')
    expect(() => guest(() => r.roomDetail(id))).toThrow()
    expect(() => guest(() => r.lobby('bad-token'))).toThrow()
    expect(() =>
      owner(() => r.createInvite(id, roomInviteInput.parse({ kind: 'direct', targetUserId: bob.id }))),
    ).toThrow()
    social.requestFriend(alice.id, bob.handle)
    social.respondFriend(bob.id, alice.id, 'accept')
    owner(() => r.updateRoom(id, updateRoomInput.parse({ contentRating: 'mature', description: 'PRIVATE PREVIEW' })))
    const direct = owner(() => r.createInvite(id, roomInviteInput.parse({ kind: 'direct', targetUserId: bob.id })))
    const notice = social.listNotifications(bob.id).items.find((n) => n.type === 'room.invite')!
    expect(notice.payload.description).toBeUndefined()
    expect(notice.payload.contentRating).toBe('mature')
    expect(() => third(() => r.lobby(direct.id))).toThrow()
    const lobby = guest(() => r.lobby(direct.id))
    expect(JSON.stringify(lobby)).not.toContain('PRIVATE CARD')
    expect(lobby.rulesVersion).toBe(2)
    expect(lobby.characters[0]?.avatarUrl).toContain(`/lobby/assets/avatars/${thumbFile(avatar)}`)
    expect(() =>
      guest(() =>
        r.joinRoom(roomJoinInput.parse({ invite: direct.id, personaId: b.personaId, acceptedRulesVersion: 1 })),
      ),
    ).toThrow()
    guest(() => r.joinRoom(roomJoinInput.parse({ invite: direct.id, personaId: b.personaId, acceptedRulesVersion: 2 })))
    expect(systemDatabase().select().from(roomInvites).where(eq(roomInvites.id, direct.id)).get()?.uses).toBe(1)
    expect(guest(() => r.listRooms())).toHaveLength(1)
    expect(guest(() => r.roomDetail(id)).myRole).toBe('player')
    expect(() => guest(() => r.createInvite(id, roomInviteInput.parse({ kind: 'link' })))).toThrow()
    const link = owner(() => r.createInvite(id, roomInviteInput.parse({ kind: 'link', maxUses: 2 })))
    expect(link.token).toHaveLength(43)
    const stored = systemDatabase().select().from(roomInvites).where(eq(roomInvites.id, link.id)).get()!
    expect(stored.tokenHash).not.toBe(link.token!)
    expect(() =>
      third(() =>
        r.joinRoom(roomJoinInput.parse({ invite: link.token, personaId: c.personaId, acceptedRulesVersion: 2 })),
      ),
    ).toThrow()
    systemDatabase().update(roomInvites).set({ revokedAt: now }).where(eq(roomInvites.id, link.id)).run()
    expect(() => third(() => r.lobby(link.token!))).toThrow()
    const expired = owner(() => r.createInvite(id, roomInviteInput.parse({ kind: 'link' })))
    systemDatabase()
      .update(roomInvites)
      .set({ expiresAt: now - 1 })
      .where(eq(roomInvites.id, expired.id))
      .run()
    expect(guest(() => r.lobby(expired.token!)).alreadyInRoom).toBe(true)
    for (const path of [
      `/chats/${b.chat.id}`,
      `/chats/${otherHostChat.id}`,
      '/characters',
      '/connections',
      '/presets',
      '/logs',
      '/lorebooks',
      '/personas',
      `/characters/${b.characterId}`,
      '/assets/avatars/UNRELATED.webp',
      `/assets/sprites/${b.characterId}/foo.webp`,
    ])
      await expect(scope(path)).rejects.toThrow()
    expect(JSON.stringify(await (await scope(`/characters/${a.characterId}`)).json())).not.toContain('PRIVATE CARD')
    for (const url of [
      sprite.url,
      sprite.thumbUrl,
      background.url,
      background.thumbUrl,
      `/api/assets/avatars/${thumbFile(avatar)}`,
    ])
      expect((await scope(url.slice(4).split('?')[0]!)).status).toBe(200)
    await expect(scope(`/assets/avatars/${avatar}`)).rejects.toThrow()
    await expect(scope(privateBackground.url.slice(4))).rejects.toThrow()
    await expect(scope(privateAttachment.url.slice(4))).rejects.toThrow()
    const copiedAvatar = guest(() => r.roomDetail(id)).members.find((m) => m.userId === bob.id)!.personaAvatarFile!
    expect(copiedAvatar).not.toBe(guestAvatar)
    expect((await scope(`/assets/avatars/${thumbFile(copiedAvatar)}`)).status).toBe(200)
    const form = new FormData()
    form.set('chatId', a.chat.id)
    form.set('file', new File([image], 'room.png', { type: 'image/png' }))
    const uploaded = await (
      await guest(() =>
        dispatchScope(id, new Request('http://local/attachments', { method: 'POST', body: form }), '/attachments'),
      )
    ).json()
    expect((await scope(uploaded.url.slice(4))).status).toBe(200)
    const page = await (await scope(`/chats/${a.chat.id}`)).json()
    expect(page.chat.apiPresetId).toBeNull()
    expect(page.chat.authorNote).toBe('')
    expect(page.messages[0].content).toBe('Welcome')
    expect(
      (
        await guest(() =>
          dispatchScope(
            id,
            new Request(`http://local/chats/${a.chat.id}/stage?before=${page.messages[0].id}`),
            `/chats/${a.chat.id}/stage`,
          ),
        )
      ).status,
    ).toBe(200)
    const input = roomSendInput.parse({ text: 'Hello AI', channel: 'ic', clientMessageId: 'one' })
    const m = guest(() => turns.sendRoomMessage(id, input))
    expect(m.meta.author).toEqual({ userId: bob.id, name: 'Bob' })
    expect(guest(() => turns.sendRoomMessage(id, input)).id).toBe(m.id)
    expect(
      owner(() => toHistory(loadGenerationContext(a.chat.id, { requireConnection: false }), m.id)).at(-1)?.name,
    ).toBe('Bob')
    const ooc = guest(() =>
      turns.sendRoomMessage(id, roomSendInput.parse({ text: 'OOC secret', channel: 'ooc', clientMessageId: 'two' })),
    )
    expect(ooc.meta.excluded).toBe(true)
    expect(
      owner(() => toHistory(loadGenerationContext(a.chat.id, { requireConnection: false }), ooc.id)).some(
        (m) => m.content === 'OOC secret',
      ),
    ).toBe(false)
    const prompt = owner(() => multiplayerPrompt(a.chat.id, ooc.id))!
    expect(prompt.user).toBe('Bob')
    expect(prompt.players).toBe('Alice and Bob')
    expect(prompt.description).toContain('Alice public persona')
    expect(prompt.note).toContain('Do not speak or act for the human players.')
    const assembled = owner(() =>
      assemble(loadGenerationContext(a.chat.id, { requireConnection: false }), {
        type: 'normal',
        leafId: ooc.id,
        speakerId: a.characterId,
      }),
    )
    expect(assembled.input.persona.name).toBe('Bob')
    expect(assembled.messages.some((message) => message.content.includes('Bob: Hello AI'))).toBe(true)
    expect(
      assembled.input.injections?.some((item) => item.id === 'multiplayer' && item.position === 'after_char'),
    ).toBe(true)
    const singleCtx = owner(() => loadGenerationContext(otherHostChat.id, { requireConnection: false }))
    const singleInput = owner(() =>
      assemble(singleCtx, { type: 'normal', leafId: otherHostChat.activeLeafId, speakerId: a.characterId }),
    )
    const { buildPrompt } = await import('@nobot/core')
    expect(singleInput.messages).toEqual(buildPrompt(singleInput.input).messages)
    expect(singleInput.input.preset).toBe(singleCtx.preset)
    expect(singleInput.input.injections?.some((item) => item.id === 'multiplayer') ?? false).toBe(false)
    expect(assembled.input.macros?.players?.('')).toBe('Alice and Bob')
    expect(guest(() => turns.editRoomMessage(id, m.id, 'Edited')).meta.version).toBe(2)
    await expect(scope(`/messages/${page.messages[0].id}`, 'PATCH', { content: 'HACK' })).rejects.toThrow()
    expect(() => guest(() => turns.triggerTurn(id))).toThrow()
    expect(() => guest(() => turns.abortTurn(id))).toThrow()
    guest(() => turns.requestTurn(id))
    expect(social.listNotifications(alice.id).items.some((n) => n.type === 'room.turn.request')).toBe(true)
    const { mockLlm } = await import('./helpers/mockLlm')
    const { createApiPreset } = await import('../src/services/connections')
    const { apiPresetInput } = await import('@nobot/shared')
    const generation = await import('../src/services/generation/generation')
    const { getChatRow, loadPath } = await import('../src/services/chats')
    const model = mockLlm()
    try {
      owner(() => createApiPreset(apiPresetInput.parse({ name: 'Mock', baseUrl: model.url, model: 'mock-one' })))
      owner(() => r.acceptRules(id, 2))
      model.setScript(() => ({ text: 'Hello Bob', delayMs: 3 }))
      const observer: LiveEnvelope[] = []
      const observerRegistration = liveHub.register(
        bob.id,
        (e) => observer.push(e),
        () => {},
      )
      await observerRegistration.join(`room:${id}`, () => true)
      owner(() => turns.triggerTurn(id))
      expect(() => owner(() => turns.triggerTurn(id))).toThrow()
      const next = guest(() => turns.sendRoomMessage(id, { ...input, text: 'Next turn', clientMessageId: 'next' }))
      while (owner(() => generation.isGenerating(a.chat.id))) await Bun.sleep(5)
      const path = owner(() => loadPath(getChatRow(a.chat.id).activeLeafId))
      expect(path.at(-1)?.id).toBe(next.id)
      expect(path.at(-2)?.content).toBe('Hello Bob')
      expect(observer.some((e) => e.type === 'room.generation' && JSON.stringify(e.data).includes('delta'))).toBe(true)
      expect(owner(() => r.usage(id))).toHaveLength(1)
      const turnEvents: LiveEnvelope[] = []
      const turnRegistration = liveHub.register(
        bob.id,
        (e) => turnEvents.push(e),
        () => {},
      )
      await turnRegistration.join(`room:${id}`, () => true)
      owner(() => turns.triggerTurn(id))
      while (owner(() => generation.isGenerating(a.chat.id))) await Bun.sleep(5)
      expect(turns.turnState(id).pending).toHaveLength(0)
      guest(() =>
        turns.sendRoomMessage(id, {
          ...input,
          text: 'Host please respond',
          clientMessageId: 'host-pending-regression',
        }),
      )
      const lastTurn = turnEvents.filter((e) => e.type === 'room.turn').at(-1)?.data as {
        payload: Record<string, unknown>
      }
      expect(lastTurn.payload).toMatchObject({ running: false, pendingCount: 1, waitingUntil: null })
      expect(typeof lastTurn.payload.cooldownUntil).toBe('number')
      turnRegistration.dispose()
      const finalEvent = observer.find(
        (e) => e.type === 'room.generation' && (e.data as { payload?: { type?: string } }).payload?.type === 'done',
      )
      expect(JSON.stringify(finalEvent)).not.toContain('logId')
      expect(JSON.stringify(finalEvent)).not.toContain('activated')
      expect(() => guest(() => turns.editRoomMessage(id, m.id, 'Consumed'))).toThrow()
      const { updateExtension } = await import('../src/extensions/registry')
      const { ttsEngines } = await import('../src/extensions/builtin/audio/tts/engines')
      owner(() => {
        updateExtension('audio', { enabled: true, settings: { ttsEnabled: true, openaiApiKey: 'mock-key' } })
        db.update(characters)
          .set({ extensions: { nobot_tts: { engine: 'openai', voice: 'coral', speed: 1 } } })
          .where(eq(characters.id, a.characterId))
          .run()
      })
      const synthesis = spyOn(ttsEngines.openai, 'synthesize').mockResolvedValue({
        bytes: Buffer.from('mock audio'),
        mime: 'audio/mpeg',
      })
      try {
        const voicePath = '/ext/audio/tts/line'
        const voiceRequest = () =>
          guest(() =>
            dispatchScope(
              id,
              new Request(`http://room${voicePath}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chatId: a.chat.id,
                  messageId: path.at(-2)!.id,
                  text: 'Hello Bob',
                  speaker: { kind: 'character', characterId: a.characterId },
                }),
              }),
              voicePath,
            ),
          )
        const [one, two] = await Promise.all([voiceRequest(), voiceRequest()])
        expect(one.status).toBe(200)
        const audio = await one.json()
        expect(await two.json()).toEqual(audio)
        expect(synthesis).toHaveBeenCalledTimes(1)
        const asset = await scope(audio.url.slice(4))
        expect(asset.status).toBe(200)
        expect(asset.headers.get('Cache-Control')).toBe('private, no-store')
        expect(owner(() => r.usage(id)).filter((row) => row.kind === 'tts')).toHaveLength(1)
      } finally {
        synthesis.mockRestore()
      }
      owner(() => r.updateRoom(id, updateRoomInput.parse({ guestQuota: { perHour: 0, perDay: 0 } })))
      expect(() => owner(() => r.asHost(r.roomRow(id), () => r.checkQuota(r.roomRow(id), bob.id)))).toThrow()
      owner(() => r.asHost(r.roomRow(id), () => r.checkQuota(r.roomRow(id), alice.id)))
      // 用可控时钟推进窗口，模型仍走真实的模拟流，避免测试等待 4–20 秒。
      let clock = Date.now()
      const scheduled = new Map<object, { at: number; run: () => void }>()
      const nowSpy = spyOn(Date, 'now').mockImplementation(() => clock)
      const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation((handler, delay = 0) => {
        const handle = { unref: () => {} }
        scheduled.set(handle, {
          at: clock + Number(delay),
          run: () => {
            if (typeof handler === 'function') handler()
          },
        })
        return handle as unknown as ReturnType<typeof setTimeout>
      })
      const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation((handle) => {
        scheduled.delete(handle as object)
      })
      const advance = async (ms: number) => {
        const target = clock + ms
        for (;;) {
          const next = [...scheduled].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
          if (!next) break
          scheduled.delete(next[0])
          clock = next[1].at
          next[1].run()
          await Bun.sleep(0)
        }
        clock = target
        await Bun.sleep(0)
      }
      const idle = async (chatId: string) => {
        while (owner(() => generation.isGenerating(chatId))) await Bun.sleep(5)
      }
      const makeTurnRoom = (turnMode: 'auto' | 'mention' | 'smart') =>
        owner(() =>
          r.createRoom(
            createRoomInput.parse({ chatId: createChat({ characterId: a.characterId }).id, name: turnMode, turnMode }),
          ),
        )
      const send = (roomId: string, text: string) =>
        owner(() =>
          turns.sendRoomMessage(roomId, roomSendInput.parse({ text, channel: 'ic', clientMessageId: newId() })),
        )
      try {
        const auto = makeTurnRoom('auto')
        const count = model.requests.length
        send(auto.id, 'First')
        await advance(1000)
        send(auto.id, 'Second')
        await advance(3900)
        expect(model.requests.length).toBe(count)
        owner(() => turns.typing(auto.id))
        await advance(4999)
        expect(model.requests.length).toBe(count)
        await advance(1)
        await idle(auto.chatId)
        expect(model.requests.length).toBe(count + 1)
        expect(owner(() => r.usage(auto.id))).toHaveLength(1)
        const capped = makeTurnRoom('auto')
        send(capped.id, 'Keep typing')
        const beforeCap = model.requests.length
        for (let n = 0; n < 14; n++) {
          await advance(1000)
          owner(() => turns.typing(capped.id))
        }
        expect(model.requests.length).toBe(beforeCap)
        await advance(1000)
        await idle(capped.chatId)
        expect(model.requests.length).toBe(beforeCap + 1)
        const mentioned = makeTurnRoom('mention')
        send(mentioned.id, 'Humans talking')
        await advance(30000)
        const beforeMention = model.requests.length
        send(mentioned.id, '@ALICE AI please reply')
        await advance(1499)
        expect(model.requests.length).toBe(beforeMention)
        await advance(1)
        await idle(mentioned.chatId)
        expect(model.requests.length).toBe(beforeMention + 1)
        const replyTarget = owner(() => getChatRow(mentioned.chatId).activeLeafId)!
        const beforeReply = model.requests.length
        owner(() =>
          turns.sendRoomMessage(
            mentioned.id,
            roomSendInput.parse({
              text: 'Tell me more',
              channel: 'ic',
              clientMessageId: newId(),
              replyTo: replyTarget,
            }),
          ),
        )
        await advance(1500)
        await idle(mentioned.chatId)
        expect(model.requests.length).toBe(beforeReply + 1)
        const cappedSmart = makeTurnRoom('smart')
        owner(() => {
          let parentId = getChatRow(cappedSmart.chatId).activeLeafId
          for (let n = 0; n < 4; n++) {
            const messageId = newId()
            db.insert(messages)
              .values({
                id: messageId,
                chatId: cappedSmart.chatId,
                parentId,
                role: 'assistant',
                content: 'AI share',
                createdAt: clock,
              })
              .run()
            parentId = messageId
          }
          db.update(chats).set({ activeLeafId: parentId }).where(eq(chats.id, cappedSmart.chatId)).run()
        })
        const beforeShare = model.requests.length
        send(cappedSmart.id, 'Alice AI please answer')
        await advance(1500)
        expect(model.requests.length).toBe(beforeShare)
        const smart = makeTurnRoom('smart')
        send(smart.id, 'Alice AI, hello')
        await advance(1500)
        await idle(smart.chatId)
        const afterSmart = model.requests.length
        send(smart.id, 'Alice AI again')
        await advance(1500)
        expect(model.requests.length).toBe(afterSmart)
        const undecided = makeTurnRoom('smart')
        model.setScript(() => ({ text: 'garbage' }))
        send(undecided.id, 'A puzzling scene')
        send(undecided.id, 'Another observation')
        send(undecided.id, 'What happens next?')
        await advance(1500)
        await Bun.sleep(10)
        expect(owner(() => r.usage(undecided.id))).toHaveLength(0)
        expect(model.requests.at(-1)?.messages.at(-1)?.content).toContain('strict JSON')
        const { createGroup } = await import('../src/services/groups')
        const forcedId = newId()
        const groupRoom = owner(() => {
          db.insert(characters).values({ id: forcedId, name: 'Aria', createdAt: clock, updatedAt: clock }).run()
          const group = createGroup({
            name: 'AI group',
            members: [{ characterId: a.characterId }, { characterId: forcedId }],
          })
          return r.createRoom(
            createRoomInput.parse({
              chatId: createChat({ groupId: group.id }).id,
              name: 'Smart group',
              turnMode: 'smart',
            }),
          )
        })
        model.setScript((body) => ({
          text: body.messages.at(-1)?.content.includes('Decide whether')
            ? '{"respond":true,"speaker":"Aria","replyTo":"Alice","reason":"question"}'
            : 'A focused reply',
        }))
        send(groupRoom.id, 'The door opens')
        send(groupRoom.id, 'A shadow moves')
        send(groupRoom.id, 'What will happen?')
        await advance(1500)
        await Bun.sleep(10)
        await idle(groupRoom.chatId)
        const groupPath = owner(() => loadPath(getChatRow(groupRoom.chatId).activeLeafId))
        expect(groupPath.at(-1)?.speakerId).toBe(forcedId)
        expect(
          model.requests.at(-1)?.messages.some((m) => m.content.includes("Reply primarily to Alice's latest message.")),
        ).toBe(true)
      } finally {
        clearSpy.mockRestore()
        timerSpy.mockRestore()
        nowSpy.mockRestore()
      }
      observerRegistration.dispose()
    } finally {
      await model.stop()
    }
    owner(() => r.updateRoom(id, updateRoomInput.parse({ status: 'paused' })))
    expect(() => guest(() => turns.sendRoomMessage(id, { ...input, clientMessageId: 'paused' }))).toThrow()
    owner(() => r.updateRoom(id, updateRoomInput.parse({ status: 'active', rules: 'New rules' })))
    expect(() => guest(() => turns.sendRoomMessage(id, { ...input, clientMessageId: 'rules' }))).toThrow()
    guest(() => r.acceptRules(id, 3))
    guest(() => turns.sendRoomMessage(id, { ...input, clientMessageId: 'accepted' }))
    guest(() => r.updatePersona(id, { name: 'Bobby', description: 'Room-only description' }))
    expect(guest(() => r.roomDetail(id)).members.find((m) => m.userId === bob.id)?.personaName).toBe('Bobby')
    expect(m.meta.author?.name).toBe('Bob')
    const renamed = guest(() => turns.sendRoomMessage(id, { ...input, channel: 'ooc', clientMessageId: 'renamed' }))
    expect(renamed.meta.author?.name).toBe('Bobby')
    let limited = false
    for (let n = 0; n < 31; n++) {
      try {
        guest(() => turns.sendRoomMessage(id, { ...input, channel: 'ooc', clientMessageId: `limit-${n}` }))
      } catch (error) {
        expect((error as { status: number }).status).toBe(429)
        limited = true
        break
      }
    }
    expect(limited).toBe(true)
    expect(() => guest(() => turns.sendRoomMessage(id, { ...input, clientMessageId: 'over-limit' }))).toThrow()
    const events: LiveEnvelope[] = []
    const reg = liveHub.register(
      bob.id,
      (e) => events.push(e),
      () => {},
      'mp2-live-connection',
    )
    expect(await reg.join(`room:${id}`, () => true)).toBe(true)
    const liveToken = 'c'.repeat(64)
    systemDatabase()
      .insert(sessions)
      .values({ tokenHash: hashToken(liveToken), userId: bob.id, renewedAt: now, expiresAt: now + 3600000 })
      .run()
    const liveServer = createServer()
    const subscribe = (since: number, connectionId = 'mp2-live-connection', topic = `room:${id}`) =>
      liveServer.request('http://local/api/live/topics', {
        method: 'POST',
        headers: { Cookie: `nobot_session=${liveToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId, topic, since }),
      })
    expect((await subscribe(0)).status).toBe(200)
    expect((await subscribe(0, 'someone-elses-connection')).status).toBe(404)
    expect((await subscribe(0, 'mp2-live-connection', 'room:not-a-member')).status).toBe(404)
    const latest = owner(
      () => db.select().from(roomEvents).where(eq(roomEvents.roomId, id)).orderBy(roomEvents.seq).all().at(-1)!.seq,
    )
    events.length = 0
    expect((await subscribe(latest - 1)).status).toBe(200)
    expect(events.some((e) => (e.data as { seq?: number }).seq === latest)).toBe(true)
    owner(() => db.delete(roomEvents).where(lt(roomEvents.seq, latest)).run())
    events.length = 0
    expect((await subscribe(1)).status).toBe(200)
    expect(events.some((e) => e.type === 'room.resync')).toBe(true)
    guest(() => turns.typing(id))
    expect(events.some((e) => e.type === 'room.typing')).toBe(true)
    owner(() => r.removeMember(id, bob.id, 'banned'))
    expect(liveHub.topicUsers(`room:${id}`)).not.toContain(bob.id)
    await expect(scope(`/chats/${a.chat.id}`)).rejects.toThrow()
    const bannedInvite = owner(() => r.createInvite(id, roomInviteInput.parse({ kind: 'link' })))
    expect(() => guest(() => r.lobby(bannedInvite.token!))).toThrow()
    const raceInvite = owner(() => r.createInvite(id, roomInviteInput.parse({ kind: 'link', maxUses: 2 })))
    social.blockUser(alice.id, carol.id)
    expect(() => third(() => r.lobby(raceInvite.token!))).toThrow()
    social.unblockUser(alice.id, carol.id)
    const seats = await Promise.allSettled([
      Promise.resolve().then(() =>
        third(() =>
          r.joinRoom(
            roomJoinInput.parse({ invite: raceInvite.token, personaId: c.personaId, acceptedRulesVersion: 3 }),
          ),
        ),
      ),
      Promise.resolve().then(() =>
        runAsUser(dave, () =>
          r.joinRoom(
            roomJoinInput.parse({ invite: raceInvite.token, personaId: d.personaId, acceptedRulesVersion: 3 }),
          ),
        ),
      ),
    ])
    expect(seats.filter((s) => s.status === 'fulfilled')).toHaveLength(1)
    expect(systemDatabase().select().from(roomInvites).where(eq(roomInvites.id, raceInvite.id)).get()?.uses).toBe(1)
    reg.dispose()
    for (const role of ['owner', 'gm', 'player'] as const) {
      const p = roomPermissions(role, true, true)
      for (const k of ['canRegenerate', 'canSwipe', 'canEditAi', 'canTrigger', 'canContinue', 'canAbort'] as const)
        expect(p[k]).toBe(role !== 'player')
    }
    expect(turns.mentions('Hi @ALICE AI', ['Alice AI'])).toBe(true)
    expect(turns.parseDecision('{"respond":true,"speaker":null,"replyTo":"Bob","reason":"question"}').respond).toBe(
      true,
    )
    for (const bad of ['garbage', '```json\n{}\n```', '{"respond":"true"}', 'null'])
      expect(turns.parseDecision(bad).respond).toBe(false)
    // HTTP 层使用真实会话，确认 scope 不能越过中间件或通过其他人的 connectionId 订阅。
    const token = 'b'.repeat(64)
    systemDatabase()
      .insert(sessions)
      .values({ tokenHash: hashToken(token), userId: bob.id, renewedAt: now, expiresAt: now + 3600000 })
      .run()
    const server = createServer()
    const response = await server.request(`http://local/api/rooms/${id}/scope/chats/${a.chat.id}`, {
      headers: { Cookie: `nobot_session=${token}` },
    })
    expect(response.status).toBe(404)
    const topics = await server.request('http://local/api/live/topics', {
      method: 'POST',
      headers: { Cookie: `nobot_session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: 'unknown', topic: `room:${id}` }),
    })
    expect(topics.status).toBe(404)
    expect(owner(() => r.usage(id))).toHaveLength(3)
    expect(() => guest(() => r.usage(id))).toThrow()
    owner(() => r.deleteRoom(id))
    expect(
      systemDatabase()
        .select()
        .from(rooms)
        .all()
        .some((room) => room.id === id),
    ).toBe(false)
    expect(
      systemDatabase()
        .select()
        .from(roomMembers)
        .all()
        .some((member) => member.roomId === id),
    ).toBe(false)
  } finally {
    for (const user of [alice, bob, carol, dave]) closeUserDatabase(user.handle)
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test('房间权限与局部更新默认值：暂停及未同意只读，GM 踢人必须授权', async () => {
  const { roomPermissions, createRoomInput, updateRoomInput } = await import('@nobot/shared')
  for (const role of ['owner', 'gm', 'player'] as const) {
    expect(roomPermissions(role, false, true).canSend).toBe(false)
    expect(roomPermissions(role, true, false).canTrigger).toBe(false)
    expect(roomPermissions(role, true, false).canSend).toBe(false)
  }
  expect(roomPermissions('gm', true, true).canKick).toBe(false)
  expect(roomPermissions('gm', true, true, false, true).canKick).toBe(true)
  expect(roomPermissions('player', true, true, true).canInvite).toBe(true)
  expect(updateRoomInput.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' })
  expect(createRoomInput.parse({ chatId: 'chat', name: 'Room' }).guestQuota).toEqual({ perHour: 30, perDay: 300 })
})

test('房间 DTO 不包含私人日志和世界书，封面不暴露带卡片数据的 PNG', async () => {
  const { roomPayload, roomCover } = await import('../src/services/rooms/dto')
  const payload = roomPayload({
    message: { chatId: 'chat', meta: { logId: 'private', lore: { activated: ['private-card'] }, name: 'Bob' } },
  })
  expect(JSON.stringify(payload)).not.toContain('private')
  expect(JSON.stringify(payload)).toContain('Bob')
  expect(roomCover('/api/assets/avatars/card.png?v=1')).toBe('/api/assets/avatars/card.webp?v=1')
})
