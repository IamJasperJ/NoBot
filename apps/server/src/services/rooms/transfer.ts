import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { db, newId } from '../../db/client'
import { apiPresets, chats as schemaChats } from '../../db/schema'
import { systemDatabase as system } from '../../db/system-client'
import { roomCharacterProposals, roomMembers, rooms, roomTransfers } from '../../db/system-schema'
import { HttpError } from '../../errors'
import { t } from '../../i18n'
import { currentContext } from '../../user-context'
import { isGenerating } from '../generation/generation'
import { resolvePlayPreset } from '../generation/stage'
import { resolveProfile } from '../profiles'
import { notifyRoom, resumeExtensions } from './extensions'
import { asHost, changed, hasRoomReservations, members, membership, refused, requireRole, roomDetail } from './index'
import { resumeRoom, stopRoomTimers } from './trpg'
import { rescheduleRoom, resetTurnState, turnState } from './turns'
import { roomView } from './view'

type Row = Record<string, string | number | null>

// 只改写数据库引用和结构化数据里的引用字段，正文和自定义变量原样迁移。
const referenceColumns = new Set([
  'id',
  'active_leaf_id',
  'avatar_file',
  'background_id',
  'character_id',
  'chat_id',
  'default_background_id',
  'entity_id',
  'group_id',
  'lorebook_id',
  'message_id',
  'parent_id',
  'play_preset_id',
  'prompt_preset_id',
  'speaker_id',
])
const referenceFields = new Set([
  'id',
  'activeLeafId',
  'attachmentId',
  'backgroundId',
  'characterId',
  'chatId',
  'copyId',
  'defaultBackgroundId',
  'groupId',
  'leafId',
  'messageId',
  'parentId',
  'replyTo',
  'speakerId',
  'pending',
  'queued',
  'activated',
  'automationIds',
  'messageIds',
])
const assetFields = new Set(['url', 'thumbUrl', 'spriteUrl', 'avatarUrl', 'coverAsset'])
const structuredColumns: Record<string, string> = {
  characters: 'extensions',
  lorebook_entries: 'data',
  messages: 'meta',
  room_events: 'payload',
  settings: 'value',
}

function mapReferences(value: unknown, map: (value: string, field: string) => string, field = ''): unknown {
  if (typeof value === 'string') return map(value, field)
  if (Array.isArray(value)) return value.map((item) => mapReferences(item, map, field))
  if (value && typeof value === 'object' && !['varsPatch', 'varsManual'].includes(field)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        field === 'characters' ? map(key, 'characterId') : key,
        mapReferences(item, map, key),
      ]),
    )
  }
  return value
}
export function transferOffer(id: string, userId: string) {
  const { room } = requireRole(id, ['owner'])
  const target = membership(id, userId).member
  if (!['gm', 'player'].includes(target.role) || userId === room.hostUserId)
    throw new HttpError(400, 'TRANSFER_INVALID_TARGET', t('只能将房间转让给其他玩家或主持'))
  const offer = system()
    .insert(roomTransfers)
    .values({ roomId: id, fromUserId: room.hostUserId, toUserId: userId, createdAt: Date.now() })
    .onConflictDoUpdate({
      target: roomTransfers.roomId,
      set: { fromUserId: room.hostUserId, toUserId: userId, createdAt: Date.now() },
    })
    .returning()
    .get()
  notifyRoom(room, userId, 'room.transfer.offered', `transfer:${id}:${offer.createdAt}`, room.hostUserId)
  return offer
}
export function getTransfer(id: string) {
  const { member } = membership(id)
  const offer = system().select().from(roomTransfers).where(eq(roomTransfers.roomId, id)).get()
  return offer && [offer.fromUserId, offer.toUserId].includes(member.userId) ? offer : null
}
export function declineTransfer(id: string) {
  const { member } = membership(id)
  const offer = getTransfer(id)
  if (!offer || offer.toUserId !== member.userId)
    throw new HttpError(409, 'TRANSFER_OFFER_UNAVAILABLE', t('房主转让邀请已失效或不适用于你'))
  system().delete(roomTransfers).where(eq(roomTransfers.roomId, id)).run()
}
/**
 * 先写唯一新素材，再在系统连接 ATTACH 新宿主库的事务中插入完整故事并切换目录。
 * 旧故事保留，房间设置移走；失败回滚目录和两端设置并删除素材。接受重试在目录切换后直接返回，避免重复复制。
 * WAL 的跨文件事务不能承诺断电原子性；应用异常可回滚，进程崩溃后需检查目录指向的新故事。
 */
export function acceptTransfer(id: string) {
  const { room, member } = membership(id)
  const offer = getTransfer(id)
  if (!offer && room.hostUserId === member.userId) return roomDetail(id)
  if (
    !offer ||
    offer.toUserId !== member.userId ||
    offer.fromUserId !== room.hostUserId ||
    !['gm', 'player'].includes(member.role)
  )
    throw new HttpError(409, 'TRANSFER_OFFER_UNAVAILABLE', t('房主转让邀请已失效或不适用于你'))
  const connection = db
    .select()
    .from(apiPresets)
    .all()
    .find((c) => c.baseUrl.trim() && c.model.trim())
  if (!connection) throw new HttpError(409, 'ROOM_CONNECTION_REQUIRED', t('请先为新房主配置可用的模型连接'))
  const target = currentContext()
  const source = asHost(room, () => currentContext())
  if (
    asHost(room, () => isGenerating(room.chatId)) ||
    turnState(id).running ||
    turnState(id).deciding ||
    hasRoomReservations(id)
  )
    throw new HttpError(409, 'GENERATING', t('房间正在生成回复'))
  const rows = (table: string, where: string, args: (string | number)[] = []) =>
    source.sqlite.query<Row, (string | number)[]>(`SELECT * FROM ${table} WHERE ${where}`).all(...args)
  const chat = rows('chats', 'id = ?', [room.chatId])[0]!
  const characterIds = new Set<string>()
  if (chat.character_id) characterIds.add(String(chat.character_id))
  const group = chat.group_id ? rows('groups', 'id = ?', [String(chat.group_id)]) : []
  const groupMembers = chat.group_id ? rows('group_members', 'group_id = ?', [String(chat.group_id)]) : []
  for (const m of groupMembers) characterIds.add(String(m.character_id))
  const messageRows = rows('messages', 'chat_id = ?', [room.chatId])
  for (const m of messageRows)
    if (m.speaker_id && rows('characters', 'id = ?', [String(m.speaker_id)]).length)
      characterIds.add(String(m.speaker_id))
  const cards = [...characterIds].flatMap((cid) => rows('characters', 'id = ?', [cid]))
  const links = [...characterIds].flatMap((cid) => rows('character_lorebooks', 'character_id = ?', [cid]))
  const chatLinks = rows('chat_lorebooks', 'chat_id = ?', [room.chatId])
  const bookIds = new Set([...links, ...chatLinks].map((l) => String(l.lorebook_id)))
  const books = [...bookIds].flatMap((bid) => rows('lorebooks', 'id = ?', [bid]))
  const entries = [...bookIds].flatMap((bid) => rows('lorebook_entries', 'lorebook_id = ?', [bid]))
  const spriteRows = [...characterIds].flatMap((cid) => rows('sprites', 'character_id = ?', [cid]))
  const settings = rows('settings', '1 = 1').filter((s) => {
    const key = String(s.key)
    return (
      (key.startsWith('room') && key.split(':')[1] === id) ||
      key === `vn-actors:${room.chatId}` ||
      key === `extdata:audio:tts-chat:${room.chatId}`
    )
  })
  const events = rows('room_events', 'room_id = ?', [id])
  const messageIndex = rows('room_message_index', 'room_id = ?', [id])
  const usage = rows('room_usage', 'room_id = ?', [id])
  const rendered = asHost(room, () => roomView(room))
  if (!chat.background_id && rendered.globalBackgroundId) chat.background_id = rendered.globalBackgroundId
  const values = [
    ...messageRows.map((row) => row.meta),
    ...settings.map((row) => row.value),
    ...events.map((row) => row.payload),
    ...cards.map((row) => row.extensions),
    ...entries.map((row) => row.data),
  ]
  const backgroundIds = new Set([
    chat.background_id,
    ...[...cards, ...group].map((row) => row.default_background_id),
    ...rendered.backgrounds.map((row) => row.id),
  ])
  const assetUrls = new Set<string>()
  const collectReference = (value: string, field: string) => {
    if (['backgroundId', 'defaultBackgroundId'].includes(field)) backgroundIds.add(value)
    if (assetFields.has(field) && value.startsWith('/api/assets/')) assetUrls.add(value.split('?')[0]!)
    return value
  }
  for (const value of values) if (typeof value === 'string') mapReferences(JSON.parse(value), collectReference)
  if (room.coverAsset) collectReference(room.coverAsset, 'coverAsset')
  for (const url of assetUrls) {
    const backgroundId = url.match(/^\/api\/assets\/backgrounds\/([^/.]+)\./)?.[1]
    if (backgroundId) backgroundIds.add(backgroundId)
  }
  const backgrounds = rows('backgrounds', '1 = 1').filter((b) => b.chat_id === room.chatId || backgroundIds.has(b.id))
  const effectivePlay = asHost(room, () => resolvePlayPreset(room.chatId))
  const play = rows('play_presets', 'id = ?', [effectivePlay.id])
  chat.play_preset_id = effectivePlay.id
  const promptId = newId()
  const prompt: Row[] = [
    {
      id: promptId,
      name: room.name,
      data: JSON.stringify(
        asHost(
          room,
          () =>
            resolveProfile(db.select().from(schemaChats).where(eq(schemaChats.id, room.chatId)).get(), false).preset,
        ),
      ),
      created_at: Date.now(),
      updated_at: Date.now(),
    },
  ]
  chat.prompt_preset_id = promptId
  const mapping = new Map<string, string>()
  for (const row of [
    chat,
    ...cards,
    ...group,
    ...messageRows,
    ...books,
    ...entries,
    ...spriteRows,
    ...backgrounds,
    ...play,
    ...prompt,
    ...usage,
  ])
    if (row.id) mapping.set(String(row.id), newId())
  const files: string[] = []
  const copied = new Map<string, string>()
  const assets = new Map<string, string>()
  const copy = (
    kind: 'avatars' | 'attachments' | 'backgrounds' | 'ttsCache' | 'sprites',
    sourceName: string,
    targetName?: string,
  ) => {
    const key = `${kind}/${sourceName}`
    if (copied.has(key)) return copied.get(key)!
    if (sourceName.includes('..') || sourceName.startsWith('/')) throw refused()
    const name = targetName ?? `${newId()}.${sourceName.split('.').slice(1).join('.')}`
    const destination = join(target.paths[kind], name)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(source.paths[kind], sourceName), destination)
    files.push(destination)
    copied.set(key, name)
    return name
  }
  const copyAsset = (kind: Parameters<typeof copy>[0], sourceName: string, targetName?: string) => {
    const path = `/api/assets/${kind === 'ttsCache' ? 'tts-cache' : kind}/`
    const name = copy(kind, sourceName, targetName)
    assets.set(`${path}${sourceName}`, `${path}${name}`)
    return name
  }
  const mapAsset = (url: string) => {
    const path = url.split('?')[0]!
    const replacement = assets.get(path)
    return replacement ? replacement + url.slice(path.length) : url
  }
  const rewrite = (value: string, field: string) => {
    if (assetFields.has(field)) return mapAsset(value)
    return referenceFields.has(field) ? (mapping.get(value) ?? value) : value
  }
  const transform = (table: string, row: Row): Row =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => {
        if (typeof value !== 'string') return [key, value]
        if (referenceColumns.has(key)) return [key, mapping.get(value) ?? value]
        if (table === 'settings' && key === 'key')
          return [
            key,
            value
              .split(':')
              .map((part) => mapping.get(part) ?? part)
              .join(':'),
          ]
        if (key === structuredColumns[table])
          return [
            key,
            JSON.stringify(
              mapReferences(JSON.parse(value), rewrite, row.key === `room-choices:${id}` ? 'messageIds' : ''),
            ),
          ]
        return [key, value]
      }),
    )
  const newProfileId = newId()
  const statement = system().$client
  let attached = false
  try {
    // 头像只迁移无卡片元数据的缩略图；原宿主卡片导出不随房间暴露。
    for (const c of cards)
      if (c.avatar_file) {
        const original = String(c.avatar_file).replace(/\.png$/, '.webp')
        const name = copyAsset('avatars', original)
        assets.set(`/api/assets/avatars/${c.avatar_file}`, `/api/assets/avatars/${name}`)
        mapping.set(String(c.avatar_file), name)
      }
    const personas = members(id).filter((m) => m.personaAvatarFile)
    for (const m of personas) {
      const file = m.personaAvatarFile!.replace(/\.png$/, '.webp')
      const name = copyAsset('avatars', file)
      assets.set(`/api/assets/avatars/${m.personaAvatarFile}`, `/api/assets/avatars/${name}`)
      mapping.set(m.personaAvatarFile!, name)
    }
    for (const s of spriteRows) {
      const cid = String(s.character_id),
        sid = String(s.id)
      for (const suffix of [String(s.ext), 'thumb.webp'])
        copyAsset('sprites', `${cid}/${sid}.${suffix}`, `${mapping.get(cid)}/${mapping.get(sid)}.${suffix}`)
    }
    for (const b of backgrounds) {
      const suffix = String(b.mime).split('/')[1]!
      copyAsset('backgrounds', `${b.id}.${suffix}`, `${mapping.get(String(b.id))}.${suffix}`)
      // 视频背景可以没有缩略图，原素材仍必须完整存在。
      if (existsSync(join(source.paths.backgrounds, `${b.id}.thumb.webp`)))
        copyAsset('backgrounds', `${b.id}.thumb.webp`, `${mapping.get(String(b.id))}.thumb.webp`)
    }
    for (const url of assetUrls) {
      const sprite = url.match(
        /^\/api\/assets\/sprites\/([0-9A-Z]{26})\/([0-9A-Z]{26})\.(png|webp|gif|jpg|thumb\.webp)$/,
      )
      if (sprite) {
        // 临时舞台角色可能没有角色表记录，仍要保留立绘和缩略图。
        const [, characterId, spriteId, ext] = sprite as [string, string, string, string]
        if (!mapping.has(characterId)) mapping.set(characterId, newId())
        if (!mapping.has(spriteId)) mapping.set(spriteId, newId())
        const original = `${characterId}/${spriteId}`
        const destination = `${mapping.get(characterId)}/${mapping.get(spriteId)}`
        copyAsset('sprites', `${original}.${ext}`, `${destination}.${ext}`)
        if (existsSync(join(source.paths.sprites, `${original}.thumb.webp`)))
          copyAsset('sprites', `${original}.thumb.webp`, `${destination}.thumb.webp`)
      }
      const attachmentId = url.match(/^\/api\/assets\/attachments\/([0-9A-Z]{26})\.webp$/)?.[1]
      if (attachmentId && existsSync(join(source.paths.attachments, `${attachmentId}.webp`))) {
        const destination = mapping.get(attachmentId) ?? newId()
        mapping.set(attachmentId, destination)
        copyAsset('attachments', `${attachmentId}.webp`, `${destination}.webp`)
        if (existsSync(join(source.paths.attachments, `${attachmentId}.json`)))
          copy('attachments', `${attachmentId}.json`, `${destination}.json`)
      }
      const voice = url.match(/^\/api\/assets\/tts-cache\/([\w-]+\.(?:mp3|wav))$/)?.[1]
      if (voice && existsSync(join(source.paths.ttsCache, voice))) copyAsset('ttsCache', voice)
    }
    const newChatId = mapping.get(room.chatId)!
    statement.query('ATTACH DATABASE ? AS transfer_story').run(target.paths.db)
    attached = true
    statement.query('ATTACH DATABASE ? AS transfer_source').run(source.paths.db)
    system().transaction(
      () => {
        // 事务内再次检查确认双方与目录，防止过期报价切换另一份故事。
        const latest = system().select().from(roomTransfers).where(eq(roomTransfers.roomId, id)).get()
        if (latest?.createdAt !== offer.createdAt || latest.toUserId !== member.userId)
          throw new HttpError(409, 'TRANSFER_OFFER_UNAVAILABLE', t('房主转让邀请已失效或不适用于你'))
        statement.exec('PRAGMA defer_foreign_keys = ON')
        // 旧宿主可能再次接回房间；以当前故事的房间索引为准，清理目标库残留，且与复制共同回滚。
        for (const table of ['room_events', 'room_message_index', 'room_usage'])
          statement.query(`DELETE FROM transfer_story.${table} WHERE room_id = ?`).run(id)
        const insert = (table: string, row: Row) => {
          const keys = Object.keys(row)
          statement
            .query(
              `INSERT INTO transfer_story.${table} (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})${table === 'settings' ? ' ON CONFLICT(key) DO UPDATE SET value = excluded.value' : ''}`,
            )
            .run(...Object.values(row))
        }
        const cleanCards = cards.map((c) => ({
          ...c,
          default_persona_id: null,
          profile_id: null,
          raw: null,
          extensions: JSON.stringify({
            ...JSON.parse(String(c.extensions)),
            room: JSON.parse(String(c.extensions)).room ?? {
              roomId: id,
              ownerUserId: room.hostUserId,
              sourceCharacterId: c.id,
            },
          }),
        }))
        const cleanGroups = group
        const tables: [string, Row[]][] = [
          ['characters', cleanCards],
          ['groups', cleanGroups],
          ['lorebooks', books.map((b) => ({ ...b, is_global: 0 }))],
          ['lorebook_entries', entries],
          ['character_lorebooks', links],
          ['group_members', groupMembers],
          ['sprites', spriteRows],
          ['play_presets', play.map((p) => ({ ...p, builtin_key: null }))],
          ['prompt_presets', prompt],
          [
            'profiles',
            [
              {
                id: newProfileId,
                name: room.name,
                api_preset_id: connection.id,
                prompt_preset_id: mapping.get(promptId)!,
                model: connection.model,
                created_at: Date.now(),
                updated_at: Date.now(),
              },
            ],
          ],
          ['chats', [{ ...chat, persona_id: null, profile_id: newProfileId, api_preset_id: connection.id }]],
          ['backgrounds', backgrounds.map((row) => ({ ...row, chat_id: row.chat_id === null ? null : room.chatId }))],
          ['chat_lorebooks', chatLinks],
          ['messages', messageRows],
          ['room_message_index', messageIndex],
          ['settings', settings],
          ['room_events', events],
          ['room_usage', usage],
        ]
        for (const [table, records] of tables) for (const record of records) insert(table, transform(table, record))
        for (const row of settings) statement.query('DELETE FROM transfer_source.settings WHERE key = ?').run(row.key!)
        for (const m of personas)
          system()
            .update(roomMembers)
            .set({ personaAvatarFile: mapping.get(m.personaAvatarFile!)! })
            .where(and(eq(roomMembers.roomId, id), eq(roomMembers.userId, m.userId)))
            .run()
        for (const p of system()
          .select()
          .from(roomCharacterProposals)
          .where(eq(roomCharacterProposals.roomId, id))
          .all())
          if (p.copyId)
            system()
              .update(roomCharacterProposals)
              .set({ copyId: mapping.get(p.copyId) ?? p.copyId })
              .where(eq(roomCharacterProposals.id, p.id))
              .run()
        system()
          .update(roomMembers)
          .set({ role: 'gm', acceptedRulesVersion: room.rulesVersion })
          .where(and(eq(roomMembers.roomId, id), eq(roomMembers.userId, room.hostUserId)))
          .run()
        system()
          .update(roomMembers)
          .set({ role: 'owner', acceptedRulesVersion: room.rulesVersion })
          .where(and(eq(roomMembers.roomId, id), eq(roomMembers.userId, member.userId)))
          .run()
        system()
          .update(rooms)
          .set({
            hostUserId: member.userId,
            chatId: newChatId,
            coverAsset: room.coverAsset ? mapAsset(room.coverAsset) : null,
            updatedAt: Date.now(),
          })
          .where(eq(rooms.id, id))
          .run()
        system().delete(roomTransfers).where(eq(roomTransfers.roomId, id)).run()
      },
      { behavior: 'immediate' },
    )
  } catch (error) {
    for (const file of files) rmSync(file, { force: true })
    throw error
  } finally {
    if (attached) {
      statement.exec('DETACH DATABASE transfer_story')
      if (
        statement
          .query<{ name: string }, []>('PRAGMA database_list')
          .all()
          .some((database) => database.name === 'transfer_source')
      )
        statement.exec('DETACH DATABASE transfer_source')
    }
  }
  stopRoomTimers(id)
  resetTurnState(id)
  const moved = roomDetail(id)
  changed(moved, 'room.transferred', member.userId, { hostUserId: member.userId, chatId: moved.chatId })
  asHost(moved, () => resumeRoom(moved))
  rescheduleRoom(id)
  resumeExtensions(moved)
  return moved
}
