import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type RoomCharacterProposalDTO, roomCharacterProposalInput, voiceRefSchema } from '@nobot/shared'
import { and, eq } from 'drizzle-orm'
import type { z } from 'zod'
import { db, newId, setSetting } from '../../db/client'
import { characterLorebooks, characters, groupMembers, lorebookEntries, lorebooks, sprites } from '../../db/schema'
import { systemDatabase as system } from '../../db/system-client'
import { roomCharacterProposals } from '../../db/system-schema'
import { HttpError } from '../../errors'
import { t } from '../../i18n'
import { thumbFile } from '../../lib/files'
import { currentPaths, currentUser } from '../../user-context'
import { getChatRow } from '../chats'
import { isGenerating } from '../generation/generation'
import { notifyRoom } from './extensions'
import { asHost, changed, checkWritable, directoryChange, members, membership, refused, unavailable } from './index'
import { initiativeSnapshot } from './trpg'

const snapshotSchema = roomCharacterProposalInput.pick({ share: true })
function approver(id: string) {
  const scope = membership(id)
  if (scope.member.role !== 'owner' && !(scope.member.role === 'gm' && scope.room.gmApprovesCharacters)) throw refused()
  return scope
}
/** 数据库保留提交时的完整快照供审批复制；所有出口只白名单投影，绝不回读已变化的来源卡。 */
function proposalDTO(row: typeof roomCharacterProposals.$inferSelect): RoomCharacterProposalDTO {
  const snapshot = row.preview
  const spriteRows = (snapshot.sprites ?? []) as { thumbnail: string }[]
  const books = (snapshot.lorebooks ?? []) as { name: string; entries: unknown[] }[]
  const preview: RoomCharacterProposalDTO['preview'] = {
    name: String(snapshot.name ?? ''),
    avatarUrl: typeof snapshot.avatar === 'string' ? `data:image/webp;base64,${snapshot.avatar}` : null,
    sprites: {
      count: spriteRows.length,
      // 已生成的 WebP 缩略图仍可能过大，只返回最多六张且每张不超过 32 KiB 的快照。
      thumbnails: spriteRows
        .filter((s) => typeof s.thumbnail === 'string' && s.thumbnail.length <= (32768 * 4) / 3)
        .slice(0, 6)
        .map((s) => `data:image/webp;base64,${s.thumbnail}`),
    },
    lorebooks: books.map((book) => ({ name: book.name, entryCount: book.entries.length })),
    voice: !!snapshot.voice,
  }
  for (const field of ['description', 'personality', 'scenario', 'mesExample'] as const)
    if (typeof snapshot[field] === 'string') preview[field] = snapshot[field]
  return { ...row, preview }
}
/** 素材直接存快照，审批不再读取来源卡，避免提交后修改卡片造成预览与批准内容不同。 */
export function proposeCharacter(id: string, input: z.infer<typeof roomCharacterProposalInput>) {
  const { room, member } = membership(id)
  checkWritable(room, member.userId)
  const character = db.select().from(characters).where(eq(characters.id, input.characterId)).get()
  if (!character || character.deletedAt) throw unavailable()
  const preview: Record<string, unknown> = { name: character.name, share: snapshotSchema.parse(input).share }
  for (const [flag, field] of [
    ['description', 'description'],
    ['personality', 'personality'],
    ['scenario', 'scenario'],
    ['exampleDialogue', 'mesExample'],
  ] as const)
    if (input.share[flag]) preview[field] = character[field]
  if (character.avatarFile) {
    const path = join(currentPaths().avatars, thumbFile(character.avatarFile))
    if (existsSync(path)) preview.avatar = readFileSync(path).toString('base64')
  }
  if (input.share.voice) preview.voice = voiceRefSchema.safeParse(character.extensions.nobot_tts).data ?? null
  if (input.share.sprites)
    preview.sprites = db
      .select()
      .from(sprites)
      .where(eq(sprites.characterId, character.id))
      .all()
      .map((s) => ({
        ...s,
        image: readFileSync(join(currentPaths().sprites, character.id, `${s.id}.${s.ext}`)).toString('base64'),
        thumbnail: readFileSync(join(currentPaths().sprites, character.id, `${s.id}.thumb.webp`)).toString('base64'),
      }))
  if (input.share.lorebook)
    preview.lorebooks = db
      .select()
      .from(characterLorebooks)
      .where(eq(characterLorebooks.characterId, character.id))
      .all()
      .map((link) => ({
        name: db.select().from(lorebooks).where(eq(lorebooks.id, link.lorebookId)).get()!.name,
        entries: db
          .select()
          .from(lorebookEntries)
          .where(eq(lorebookEntries.lorebookId, link.lorebookId))
          .all()
          .map((e) => ({ sort: e.sort, data: e.data })),
      }))
  const proposal = system()
    .insert(roomCharacterProposals)
    .values({
      id: newId(),
      roomId: id,
      userId: member.userId,
      sourceCharacterId: character.id,
      preview,
      note: input.note,
      createdAt: Date.now(),
    })
    .returning()
    .get()
  for (const m of members(id))
    if (m.role === 'owner' || (m.role === 'gm' && room.gmApprovesCharacters))
      notifyRoom(room, m.userId, 'room.character.proposed', `proposal:${proposal.id}:${m.userId}`, member.userId)
  return proposalDTO(proposal)
}
export function listProposals(id: string): RoomCharacterProposalDTO[] {
  const { room, member } = membership(id)
  const all = member.role === 'owner' || (member.role === 'gm' && room.gmApprovesCharacters)
  return system()
    .select()
    .from(roomCharacterProposals)
    .where(eq(roomCharacterProposals.roomId, id))
    .all()
    .filter((p) => p.userId === member.userId || member.role === 'owner' || (all && p.status === 'pending'))
    .map(proposalDTO)
}
export function getProposal(id: string, proposalId: string): RoomCharacterProposalDTO {
  const { room, member } = membership(id)
  const p = proposalRow(id, proposalId)
  if (
    p.userId !== member.userId &&
    member.role !== 'owner' &&
    !(member.role === 'gm' && room.gmApprovesCharacters && p.status === 'pending')
  )
    throw unavailable()
  return proposalDTO(p)
}
function proposalRow(id: string, proposalId: string) {
  const p = system()
    .select()
    .from(roomCharacterProposals)
    .where(and(eq(roomCharacterProposals.roomId, id), eq(roomCharacterProposals.id, proposalId)))
    .get()
  if (!p) throw unavailable()
  return p
}
export function decideProposal(id: string, proposalId: string, approve: boolean) {
  const { room } = approver(id)
  const p = proposalRow(id, proposalId)
  if (p.status !== 'pending') return proposalDTO(p)
  if (approve) membership(id, p.userId)
  const actor = currentUser().id
  const copyId = approve ? newId() : null
  const files: string[] = []
  try {
    asHost(room, () => {
      if (isGenerating(room.chatId)) throw new HttpError(409, 'GENERATING', t('房间正在生成回复'))
      const preview = p.preview
      const write = (path: string, data: string) => {
        writeFileSync(path, Buffer.from(data, 'base64'))
        files.push(path)
      }
      if (approve) {
        if (typeof preview.avatar === 'string') write(join(currentPaths().avatars, `${copyId}.webp`), preview.avatar)
        const spriteRows = (preview.sprites ?? []) as (typeof sprites.$inferSelect & {
          image: string
          thumbnail: string
        })[]
        if (spriteRows.length) mkdirSync(join(currentPaths().sprites, copyId!), { recursive: true })
        for (const s of spriteRows) {
          write(join(currentPaths().sprites, copyId!, `${s.id}.${s.ext}`), s.image)
          write(join(currentPaths().sprites, copyId!, `${s.id}.thumb.webp`), s.thumbnail)
        }
      }
      // ATTACH 事务同时发布副本与审批状态；素材先写新路径，失败时清理，不覆盖现有文件。
      directoryChange(
        room,
        actor,
        approve ? 'room.character.approved' : 'room.character.rejected',
        { proposalId, copyId },
        () => {
          if (approve) {
            const sqlite = system().$client
            const insert = (table: string, row: Record<string, unknown>) => {
              const keys = Object.keys(row)
              sqlite
                .query(`INSERT INTO room_story.${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
                .run(
                  ...(Object.values(row).map((v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : v)) as (
                    | string
                    | number
                    | null
                  )[]),
                )
            }
            const now = Date.now()
            insert('characters', {
              id: copyId,
              name: preview.name,
              description: preview.description ?? '',
              personality: preview.personality ?? '',
              scenario: preview.scenario ?? '',
              mes_example: preview.mesExample ?? '',
              avatar_file: preview.avatar ? `${copyId}.webp` : null,
              extensions: {
                room: { roomId: id, ownerUserId: p.userId, sourceCharacterId: p.sourceCharacterId },
                ...(preview.voice ? { nobot_tts: preview.voice } : {}),
              },
              created_at: now,
              updated_at: now,
            })
            for (const s of (preview.sprites ?? []) as (typeof sprites.$inferSelect)[])
              insert('sprites', {
                id: newId(),
                character_id: copyId,
                outfit: s.outfit,
                expression: s.expression,
                ext: s.ext,
                width: s.width,
                height: s.height,
                created_at: now,
                updated_at: now,
              })
            // 来源素材先落在副本目录，再按新立绘 ID 重命名，避免与宿主原卡的 ID 冲突。
            const inserted = sqlite
              .query<{ id: string; ext: string }, [string]>(
                'SELECT id, ext FROM room_story.sprites WHERE character_id = ?',
              )
              .all(copyId!)
            const sourceSprites = (preview.sprites ?? []) as (typeof sprites.$inferSelect)[]
            inserted.forEach((s, i) => {
              copyFileSync(
                join(currentPaths().sprites, copyId!, `${sourceSprites[i]!.id}.${s.ext}`),
                join(currentPaths().sprites, copyId!, `${s.id}.${s.ext}`),
              )
              copyFileSync(
                join(currentPaths().sprites, copyId!, `${sourceSprites[i]!.id}.thumb.webp`),
                join(currentPaths().sprites, copyId!, `${s.id}.thumb.webp`),
              )
            })
            for (const [position, book] of (
              (preview.lorebooks ?? []) as { name: string; entries: { sort: number; data: unknown }[] }[]
            ).entries()) {
              const bookId = newId()
              insert('lorebooks', { id: bookId, name: book.name, created_at: now, updated_at: now })
              insert('character_lorebooks', { character_id: copyId, lorebook_id: bookId, position })
              for (const e of book.entries)
                insert('lorebook_entries', { id: newId(), lorebook_id: bookId, sort: e.sort, data: e.data })
            }
            const chat = getChatRow(room.chatId)
            let groupId = chat.groupId
            if (!groupId) {
              groupId = newId()
              insert('groups', { id: groupId, name: room.name, created_at: now, updated_at: now })
              insert('group_members', { group_id: groupId, character_id: chat.characterId, position: 0 })
              // 补全所有分支的旧 AI 署名，消息及父子关系原封保留。
              sqlite
                .query(
                  "UPDATE room_story.messages SET speaker_id = ? WHERE chat_id = ? AND role = 'assistant' AND speaker_id IS NULL",
                )
                .run(chat.characterId, room.chatId)
              sqlite
                .query('UPDATE room_story.chats SET group_id = ?, character_id = NULL WHERE id = ?')
                .run(groupId, room.chatId)
            }
            const n = sqlite
              .query<{ n: number }, [string]>('SELECT count(*) AS n FROM room_story.group_members WHERE group_id = ?')
              .get(groupId)!.n
            insert('group_members', { group_id: groupId, character_id: copyId, position: n })
          }
          system()
            .update(roomCharacterProposals)
            .set({ status: approve ? 'approved' : 'rejected', copyId })
            .where(eq(roomCharacterProposals.id, proposalId))
            .run()
        },
      )
    })
  } catch (error) {
    for (const path of files) rmSync(path, { force: true })
    if (copyId) asHost(room, () => rmSync(join(currentPaths().sprites, copyId), { recursive: true, force: true }))
    throw error
  }
  notifyRoom(
    room,
    p.userId,
    approve ? 'room.character.approved' : 'room.character.rejected',
    `proposal-decision:${proposalId}`,
    actor,
  )
  return proposalDTO(proposalRow(id, proposalId))
}
export function withdrawCharacter(id: string, copyId: string) {
  const { room, member } = membership(id)
  asHost(room, () => {
    const c = db.select().from(characters).where(eq(characters.id, copyId)).get()
    const ownership = c?.extensions.room as { roomId?: string; ownerUserId?: string } | undefined
    if (ownership?.roomId !== id || ownership.ownerUserId !== member.userId) throw refused()
    const chat = getChatRow(room.chatId)
    if (!chat.groupId) throw new HttpError(409, 'ROOM_CHARACTER_NOT_IN_GROUP', t('当前房间不是群聊，无法撤回角色'))
    if (isGenerating(room.chatId)) throw new HttpError(409, 'GENERATING', t('房间正在生成回复'))
    db.update(groupMembers)
      .set({ muted: true })
      .where(and(eq(groupMembers.groupId, chat.groupId), eq(groupMembers.characterId, copyId)))
      .run()
    const initiative = initiativeSnapshot(room)
    const current = initiative.order[initiative.current]
    initiative.order = initiative.order.filter((e) => e.kind !== 'character' || e.id !== copyId)
    initiative.current = Math.max(
      0,
      initiative.order.findIndex((e) => e.id === current?.id),
    )
    setSetting(`room.initiative:${id}`, initiative)
    changed(room, 'room.character.withdrawn', member.userId, { copyId })
  })
}
