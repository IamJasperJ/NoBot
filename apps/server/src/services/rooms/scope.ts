import {
  characterInput,
  choiceCheckInput,
  generateInput,
  rollVisibility,
  roomRollInput,
  setVarsInput,
  swipeInput,
} from '@nobot/shared'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../../db/client'
import { backgrounds, messages, roomEvents } from '../../db/schema'
import { messageSegments } from '../../extensions/builtin/audio/tts/service'
import { forwardExtension } from '../../extensions/registry'
import { thumbFile } from '../../lib/files'
import { assetRoutes } from '../../routes/assets'
import { characterRoutes } from '../../routes/characters'
import { chatRoutes } from '../../routes/chats'
import { currentUser } from '../../user-context'
import { characterCgs, saveAttachment } from '../attachments'
import { getCharacter } from '../characters'
import { getChatPage, getChatRow, loadMessage, loadPath, setVars, swipe } from '../chats'
import { isGenerating } from '../generation/generation'
import { computeStage } from '../generation/stage'
import { readTemporaryActors } from '../sprites/temporary-actors'
import { asRoomViewer, canReadMessage, roomCover, roomMessage } from './dto'
import { visibleHistory } from './extensions'
import {
  asHost,
  charactersForRoom,
  checkWritable,
  event,
  members,
  membership,
  publish,
  roomDetail,
  unavailable,
} from './index'
import { validateEdit } from './input'
import { checkRoom, rollRoom } from './trpg'
import { abortTurn, editRoomMessage, triggerTurn } from './turns'
import { runAsRoomActor } from './usage'
import { roomView } from './view'
import { roomVoice } from './voice'

const internal = new Hono()
  .route('/chats', chatRoutes)
  .route('/assets', assetRoutes)
  .route('/characters', characterRoutes)

/** 仅此处可把访客请求转入房主上下文；路径、查询和对象归属必须全部通过白名单。 */
export function dispatchScope(roomId: string, request: Request, path: string) {
  return asRoomViewer(currentUser().id, () => dispatchRoomScope(roomId, request, path))
}
async function dispatchRoomScope(roomId: string, request: Request, path: string) {
  const { room, member } = membership(roomId)
  if (member.role === 'spectator' && request.method !== 'GET') throw unavailable()
  const actor = currentUser().id
  const url = new URL(request.url)
  const method = request.method
  // 禁止编码路径、重复斜线与任何隐式路径归一化带来的白名单绕过。
  if (path.includes('%') || path.includes('..') || path.includes('//')) throw unavailable()
  if (method === 'POST' && path === '/ext/image-gen/commands/imagine') {
    checkWritable(room, actor)
    if (!roomDetail(roomId).permissions.canGenerateImages) throw unavailable()
    const body: unknown = await request.json()
    if (!body || typeof body !== 'object' || !('chatId' in body) || body.chatId !== room.chatId) throw unavailable()
    return asHost(room, () =>
      runAsRoomActor(actor, () =>
        forwardExtension(
          'image-gen',
          new Request('http://room/api/ext/image-gen/commands/imagine', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
        ),
      ),
    )
  }
  if (method === 'GET' && path === `/ext/audio/tts/chat/${room.chatId}`) {
    return asHost(room, async () => {
      const response = await forwardExtension('audio', new Request(`http://room/api${path}`))
      if (!response.ok) return response
      const data = (await response.json()) as { effective?: unknown }
      // 访客只需播放策略，不读取房主的声音绑定和供应商配置。
      return Response.json({ effective: data.effective })
    })
  }
  if (method === 'POST' && path === '/ext/audio/tts/message') {
    const body: unknown = await request.json()
    if (!body || typeof body !== 'object' || !('messageId' in body) || typeof body.messageId !== 'string')
      throw unavailable()
    const messageId = body.messageId
    return asHost(room, () => {
      const message = loadMessage(messageId)
      if (message.chatId !== room.chatId || !canReadMessage(message, actor, room.hostUserId)) throw unavailable()
      return Response.json(messageSegments(messageId))
    })
  }
  if (method === 'POST' && path === `/chats/${room.chatId}/roll`) {
    const input = roomRollInput.safeParse(await request.json())
    if (!input.success) throw unavailable()
    return Response.json(rollRoom(roomId, input.data))
  }
  if (method === 'POST' && path === `/chats/${room.chatId}/check`) {
    const input = choiceCheckInput
      .extend({ visibility: rollVisibility.default('public') })
      .safeParse(await request.json())
    if (!input.success) throw unavailable()
    return Response.json(checkRoom(roomId, input.data))
  }
  if (method === 'POST' && path === '/ext/audio/tts/line') return roomVoice(roomId, request)
  if (method === 'POST' && path === '/attachments') {
    checkWritable(room, actor)
    const body = await request.formData()
    if (body.get('chatId') !== room.chatId) throw unavailable()
    const file = body.get('file')
    if (!(file instanceof File) || file.size > 10 * 1024 * 1024) throw unavailable()
    return asHost(room, async () => {
      const attachment = await saveAttachment(new Uint8Array(await file.arrayBuffer()))
      const data = db.transaction(() => event(room, 'room.asset', actor, { attachment }, attachment.id))
      publish(data)
      return Response.json(attachment)
    })
  }
  if (method === 'POST' && path === `/chats/${room.chatId}/abort`) {
    abortTurn(roomId)
    return Response.json({ ok: true })
  }
  if (method === 'POST' && path === `/chats/${room.chatId}/generate`) {
    const parsed = generateInput.safeParse(await request.json())
    if (!parsed.success || parsed.data.mode === 'send') throw unavailable()
    const input = parsed.data
    if ('targetId' in input)
      asHost(room, () => {
        if (loadMessage(input.targetId).chatId !== room.chatId) throw unavailable()
      })
    return Response.json(triggerTurn(roomId, actor, true, parsed.data))
  }
  const messageMatch = /^\/messages\/([^/]+)$/.exec(path)
  if (messageMatch && (method === 'PATCH' || method === 'DELETE')) {
    const body: unknown = method === 'PATCH' ? await request.json() : null
    const content =
      method === 'PATCH'
        ? validateEdit(body && typeof body === 'object' && 'content' in body ? body.content : undefined)
        : null
    return Response.json(editRoomMessage(roomId, messageMatch[1]!, content))
  }
  const body =
    method === 'POST'
      ? await request
          .clone()
          .json()
          .catch(() => null)
      : undefined
  return asHost(room, async () => {
    const chars = charactersForRoom(room),
      chatPath = `/chats/${room.chatId}`
    let allowed = false
    if (method === 'GET' && path === chatPath) {
      for (const k of url.searchParams.keys()) if (!['before', 'limit'].includes(k)) throw unavailable()
      const page = getChatPage(
        room.chatId,
        { before: url.searchParams.get('before') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 100) },
        isGenerating(room.chatId),
      )
      page.roomView = roomView(room)
      // 聊天界面只需要公开叙事数据，连接、提示词、人设与世界书引用不属于房间权限。
      page.chat = {
        ...page.chat,
        profileId: null,
        apiPresetId: null,
        promptPresetId: null,
        personaId: null,
        authorNote: '',
        lorebookIds: [],
        quickReplySetIds: [],
      }
      if (page.group) page.group = { ...page.group, scenarioOverride: '' }
      if (member.role === 'spectator') {
        const visible = visibleHistory(roomId, actor)
        const before = url.searchParams.get('before')
        const end = before ? visible.findIndex((m) => m.id === before) : visible.length
        if (end < 0) throw unavailable()
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? 100)))
        page.messages = visible.slice(Math.max(0, end - limit), end)
        page.hasMore = end > limit
      }
      page.messages = page.messages
        .filter((m) => member.role !== 'spectator' || canReadMessage(m, actor, room.hostUserId))
        .map((message) => roomMessage(message, actor, room.hostUserId))
      return Response.json(page)
    }
    if (method === 'GET' && path === `${chatPath}/stage`) {
      const before = url.searchParams.get('before')
      if (
        !before ||
        loadMessage(before).chatId !== room.chatId ||
        [...url.searchParams.keys()].some((k) => k !== 'before')
      )
        throw unavailable()
      allowed = true
    }
    if (method === 'POST' && path === `${chatPath}/swipe` && ['owner', 'gm'].includes(member.role)) {
      const parsed = swipeInput.safeParse(body)
      if (!parsed.success || loadMessage(parsed.data.messageId).chatId !== room.chatId) throw unavailable()
      const data = db.transaction(() => {
        const leafId = swipe(room.chatId, parsed.data.messageId, parsed.data.direction)
        return { leafId, event: event(room, 'room.message', actor, { action: 'activated', leafId }) }
      })
      publish(data.event)
      return Response.json({ leafId: data.leafId })
    }
    if (method === 'POST' && path === `${chatPath}/vars` && ['owner', 'gm'].includes(member.role)) {
      const parsed = setVarsInput.safeParse(body)
      if (!parsed.success) throw unavailable()
      const data = db.transaction(() => {
        const result = setVars(room.chatId, parsed.data)
        const message = loadMessage(getChatRow(room.chatId).activeLeafId!)
        return { result, event: event(room, 'room.message', actor, { action: 'updated', message }, message.id) }
      })
      publish(data.event)
      return Response.json(data.result)
    }
    const characterPath = /^\/characters\/([^/]+)$/.exec(path)
    if (method === 'GET' && characterPath) {
      const character = chars.find((c) => c.id === characterPath[1])
      if (!character) throw unavailable()
      const ownership = character.extensions.room as { roomId?: string; ownerUserId?: string } | undefined
      if (ownership?.roomId === roomId && (actor === room.hostUserId || actor === ownership.ownerUserId)) {
        return Response.json(getCharacter(character.id))
      }
      return Response.json({
        ...characterInput.parse({
          name: character.name,
          description: ownership?.roomId === roomId ? character.description : '',
          defaultBackgroundId: character.defaultBackgroundId,
        }),
        id: character.id,
        avatarUrl: character.avatarFile ? `/api/assets/avatars/${thumbFile(character.avatarFile)}` : null,
        createdAt: character.createdAt,
        updatedAt: character.updatedAt,
      })
    }
    const cgList = /^\/characters\/([^/]+)\/cgs$/.exec(path)
    if (method === 'GET' && cgList && chars.some((c) => c.id === cgList[1])) {
      return Response.json(
        characterCgs(cgList[1]!).filter(
          (cg) => cg.chatId === room.chatId && canReadMessage(loadMessage(cg.messageId), actor, room.hostUserId),
        ),
      )
    }
    const spriteList = /^\/characters\/([^/]+)\/sprites$/.exec(path)
    if (method === 'GET' && spriteList && chars.some((c) => c.id === spriteList[1])) allowed = true
    const sprite = /^\/assets\/sprites\/([^/]+)\/([^/]+)$/.exec(path)
    if (
      method === 'GET' &&
      sprite &&
      (chars.some((c) => c.id === sprite[1]) ||
        Object.values(readTemporaryActors(room.chatId)).some(
          (actor) => actor.status !== 'removed' && actor.image?.url.split('?')[0] === `/api${path}`,
        ))
    )
      allowed = true
    const asset = /^\/assets\/(avatars|attachments|backgrounds|tts-cache)\/([^/]+)$/.exec(path)
    if (method === 'GET' && asset) {
      const [, kind, file] = asset
      if (kind === 'avatars')
        // 角色 PNG 可能内嵌完整角色卡，只共享重新编码过的缩略图。
        allowed =
          chars.some((c) => c.avatarFile && thumbFile(c.avatarFile) === file) ||
          members(roomId).some((m) => m.personaAvatarFile && thumbFile(m.personaAvatarFile) === file)
      else {
        const rows = db
          .select()
          .from(messages)
          .where(eq(messages.chatId, room.chatId))
          .all()
          .filter((message) => canReadMessage(message, actor, room.hostUserId))
        const assetUrl = `/api/assets/${kind}/${file}`
        // 只认结构化资源引用，不能把玩家正文里的任意字符串当作资源所有权。
        allowed =
          rows.some((m) =>
            kind === 'attachments'
              ? m.meta.images?.some((image) => image.url.split('?')[0] === assetUrl) ||
                m.meta.cg?.some((cg) => `${cg.attachmentId}.webp` === file)
              : false,
          ) ?? false
        if (kind === 'tts-cache')
          allowed =
            rows.some((m) => m.meta.ttsCache?.some((cache) => cache.url === assetUrl)) ||
            db
              .select()
              .from(roomEvents)
              .where(eq(roomEvents.roomId, room.id))
              .all()
              .some(
                (e) =>
                  e.type === 'room.asset' &&
                  e.payload.url === assetUrl &&
                  (!e.entityId ||
                    !db.select().from(messages).where(eq(messages.id, e.entityId)).get() ||
                    canReadMessage(loadMessage(e.entityId), actor, room.hostUserId)),
              )
        if (kind === 'attachments' && !allowed)
          allowed = db
            .select()
            .from(roomEvents)
            .where(eq(roomEvents.roomId, room.id))
            .all()
            .some((e) => e.type === 'room.asset' && e.entityId && `${e.entityId}.webp` === file)
        if (kind === 'backgrounds') {
          const chat = getChatRow(room.chatId)
          const bg = chat.backgroundId
            ? db.select().from(backgrounds).where(eq(backgrounds.id, chat.backgroundId)).get()
            : undefined
          const owned = db.select().from(backgrounds).where(eq(backgrounds.chatId, room.chatId)).all()
          const stageId = computeStage(room.chatId, loadPath(chat.activeLeafId))?.scene.backgroundId
          const stage = stageId ? db.select().from(backgrounds).where(eq(backgrounds.id, stageId)).get() : undefined
          if (
            [...owned, ...(bg ? [bg] : []), ...(stage ? [stage] : [])].some(
              (b) => `${b.id}.${b.mime.split('/')[1]}` === file || `${b.id}.thumb.webp` === file,
            )
          )
            allowed = true
          if (roomView(room).backgrounds.some((b) => b.url === assetUrl || b.thumbUrl === assetUrl)) allowed = true
        }
      }
    }
    if (method === 'GET' && asset && roomCover(room.coverAsset)?.split('?')[0] === `/api${path}`) allowed = true
    if (!allowed) throw unavailable()
    const target = new URL(`http://room${path}`)
    target.search = url.search
    const response = await internal.fetch(new Request(target.toString(), request))
    const headers = new Headers(response.headers)
    // 每次下载都重新鉴权；被踢后的浏览器不可继续从共享 HTTP 缓存取得房间资源。
    headers.set('Cache-Control', 'private, no-store')
    return new Response(response.body, { status: response.status, headers })
  })
}
