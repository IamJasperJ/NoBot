import { eq } from 'drizzle-orm'
import { decodeTime } from 'ulid'
import { db, newId } from '../db/client'
import { characters, chats, groupMembers, messages, personas } from '../db/schema'
import { HttpError } from '../errors'
import { t } from '../i18n'
import { readAvatar as avatarFile, avatarUrl } from '../lib/files'
import { saveAttachment } from '../services/attachments'
import { saveBackground } from '../services/backgrounds/backgrounds'
import { getCharacter, updateCharacter } from '../services/characters'
import {
  activateMessage,
  branchChat,
  createChat,
  deleteMessage,
  editMessage,
  getChatPage,
  getChatRow,
  listChats,
  loadMessage,
  loadPath,
  swipe,
  updateChat,
} from '../services/chats'
import { loadGenerationContext } from '../services/generation/context'
import { abortGeneration, isGenerating, startGeneration, subscribe } from '../services/generation/generation'
import { complete, quietPrompt } from '../services/generation/quiet-prompt'
import { insertLog } from '../services/logs'
import { performCheck } from '../services/trpg/trpg'
import { transcribe } from './builtin/audio/asr/service'
import { type AudioContext, synthesizeSpeech } from './builtin/audio/tts/host'
import type { ExtensionHost, ServerEvent } from './types'

/** 由注册表注入事件出口，宿主不反向导入注册表。 */
export function createExtensionHost(
  emit: (event: ServerEvent) => void,
  audioContext: () => AudioContext | undefined = () => undefined,
): ExtensionHost {
  const host: ExtensionHost = {
    async synthesizeSpeech(chatId, messageId, opts) {
      const ctx = audioContext()
      return ctx
        ? synthesizeSpeech(host, ctx, chatId, messageId, opts)
        : { kind: 'unavailable', reason: 'audio-disabled' }
    },
    async transcribe(bytes, mime, opts) {
      const ctx = audioContext()
      return ctx ? transcribe(bytes, mime, ctx.settings, opts) : { kind: 'unavailable', reason: 'audio-disabled' }
    },
    generate: startGeneration,
    subscribe,
    abort: abortGeneration,
    swipe,
    editMessage,
    deleteMessage,
    activateMessage,
    branchChat,
    createChat,
    listChats,
    performCheck,
    quietPrompt,
    complete,
    listGeneratedImages(characterId) {
      const groups = new Set(
        db
          .select()
          .from(groupMembers)
          .where(eq(groupMembers.characterId, characterId))
          .all()
          .map((row) => row.groupId),
      )
      const chatIds = new Set(
        db
          .select()
          .from(chats)
          .all()
          .filter((row) => row.characterId === characterId || (row.groupId && groups.has(row.groupId)))
          .map((row) => row.id),
      )
      return db
        .select()
        .from(messages)
        .all()
        .filter((row) => chatIds.has(row.chatId) && row.meta.imageGen)
        .flatMap((row) =>
          (row.meta.images ?? []).map((image) => ({
            chatId: row.chatId,
            messageId: row.id,
            image,
            prompt: row.meta.imageGen?.prompt ?? '',
            createdAt: (() => {
              // 附件 ID 含保存时间，让旧消息里新增的候选也排到图库前面。
              try {
                return decodeTime(image.id)
              } catch {
                return row.createdAt
              }
            })(),
          })),
        )
        .sort((a, b) => b.createdAt - a.createdAt || b.image.id.localeCompare(a.image.id))
    },
    getCharacter,
    updateCharacterExtensions(id, patch) {
      return db.transaction(() => updateCharacter(id, { extensions: { ...getCharacter(id).extensions, ...patch } }))
    },
    async readAvatar(kind, id) {
      const row =
        kind === 'character'
          ? db.select().from(characters).where(eq(characters.id, id)).get()
          : db.select().from(personas).where(eq(personas.id, id)).get()
      if (!row?.avatarFile) return null
      const file = avatarFile(row.avatarFile)
      return (await file.exists()) ? new Uint8Array(await file.arrayBuffer()) : null
    },
    saveImage: saveAttachment,
    saveBackground,
    setChatBackground(chatId, backgroundId) {
      updateChat(chatId, { backgroundId })
    },
    appendMessage(chatId, message) {
      if (isGenerating(chatId)) throw new HttpError(409, 'BUSY', t('会话正在生成，请稍后再试'))
      const id = newId()
      db.transaction((tx) => {
        const chat = getChatRow(chatId)
        const now = Date.now()
        tx.insert(messages)
          .values({ ...message, id, chatId, parentId: chat.activeLeafId, createdAt: now })
          .run()
        tx.update(chats).set({ activeLeafId: id, updatedAt: now }).where(eq(chats.id, chatId)).run()
      })
      const saved = loadMessage(id)
      emit({ type: 'message:saved', message: saved })
      return saved
    },
    updateMessageMeta(messageId, patch) {
      db.transaction((tx) => {
        const message = loadMessage(messageId)
        tx.update(messages)
          .set({ meta: { ...message.meta, ...patch } })
          .where(eq(messages.id, messageId))
          .run()
      })
      const saved = loadMessage(messageId)
      emit({ type: 'message:updated', message: saved })
      return saved
    },
    getChatInfo(chatId, limit = 20) {
      const ctx = loadGenerationContext(chatId, { requireConnection: false })
      const persona = ctx.persona.id
        ? db.select().from(personas).where(eq(personas.id, ctx.persona.id)).get()
        : undefined
      return {
        chat: getChatPage(chatId, { limit: 1 }, isGenerating(chatId)).chat,
        characters: ctx.members.map((member) => {
          const character = getCharacter(member.id)
          return {
            id: member.id,
            name: member.name,
            description: member.fields.description,
            personality: member.fields.personality,
            scenario: member.fields.scenario,
            muted: member.muted ?? false,
            extensions: character.extensions,
            avatarUrl: character.avatarUrl,
          }
        }),
        persona: {
          id: ctx.persona.id ?? undefined,
          name: ctx.persona.name,
          description: ctx.persona.description,
          avatarUrl: persona ? avatarUrl(persona.avatarFile, persona.updatedAt) : null,
        },
        messages: limit <= 0 ? [] : loadPath(ctx.chat.activeLeafId, Math.max(1, Math.floor(limit))),
      }
    },
    async waitIdle(chatId, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (isGenerating(chatId)) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new HttpError(408, 'WAIT_IDLE_TIMEOUT', t('等待文本生成结束超时，请稍后再试'))
        await Bun.sleep(Math.min(300, remaining))
      }
    },
    isGenerating(chatId) {
      return isGenerating(chatId)
    },
    log(entry) {
      insertLog(entry)
    },
  }
  return host
}
