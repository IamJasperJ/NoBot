import { AsyncLocalStorage } from 'node:async_hooks'
import { parsePresetWithEnglishDefaults } from '@nobot/core'
import { type ProfileDTO, type ProfileInput, profileInput, type ResolvedProfileDTO } from '@nobot/shared'
import { asc, eq } from 'drizzle-orm'
import { db, getSetting, newId, setSetting } from '../db/client'
import { type ChatRow, characters, chats, profiles, promptPresets } from '../db/schema'
import { notFound } from '../errors'
import { t } from '../i18n'
import { getApiPresetRow, listApiPresets, resolveApiPreset } from './connections'
import { SETTING_KEYS } from './settings'

/** 请求中的会话仅用于图片扩展草稿解析，异步并发之间互不共享。 */
export const profileChatScope = new AsyncLocalStorage<string>()

export function getProfile(id: string): ProfileDTO {
  const row = db.select().from(profiles).where(eq(profiles.id, id)).get()
  if (!row) throw notFound(t('连接配置组'))
  return { ...row, isDefault: getSetting(SETTING_KEYS.defaultProfileId) === id }
}
export function listProfiles(): ProfileDTO[] {
  return db
    .select()
    .from(profiles)
    .orderBy(asc(profiles.name))
    .all()
    .map((row) => getProfile(row.id))
}
export function saveProfile(input: ProfileInput, id?: string): ProfileDTO {
  const data = profileInput.parse(input)
  if (id) getProfile(id)
  for (const key of ['apiPresetId', 'imageConnectionId', 'promptConnectionId'] as const)
    if (data[key]) getApiPresetRow(data[key])
  if (data.promptPresetId && !db.select().from(promptPresets).where(eq(promptPresets.id, data.promptPresetId)).get())
    throw notFound(t('生成预设'))
  const now = Date.now()
  if (id)
    db.update(profiles)
      .set({ ...data, updatedAt: now })
      .where(eq(profiles.id, id))
      .run()
  else {
    id = newId()
    db.insert(profiles)
      .values({ ...data, id, createdAt: now, updatedAt: now })
      .run()
  }
  return getProfile(id)
}
export function setDefaultProfile(id: string | null) {
  if (id) getProfile(id)
  setSetting(SETTING_KEYS.defaultProfileId, id)
}
export function deleteProfile(id: string) {
  getProfile(id)
  db.transaction(() => {
    db.update(characters).set({ profileId: null }).where(eq(characters.profileId, id)).run()
    db.update(chats).set({ profileId: null }).where(eq(chats.profileId, id)).run()
    db.delete(profiles).where(eq(profiles.id, id)).run()
    if (getSetting(SETTING_KEYS.defaultProfileId) === id) setDefaultProfile(null)
  })
}

/** 配置组整体选择，不把不同层级的组拼在一起；缺省字段沿用旧设置。 */
export function selectProfile(chat?: Pick<ChatRow, 'profileId' | 'characterId' | 'groupId'>): {
  profile: ProfileDTO | null
  source: ResolvedProfileDTO['source']
} {
  const characterId =
    !chat?.groupId && chat?.characterId
      ? db.select().from(characters).where(eq(characters.id, chat.characterId)).get()?.profileId
      : null
  const candidates = [
    [chat?.profileId, 'chat'],
    [characterId, 'character'],
    [getSetting<string>(SETTING_KEYS.defaultProfileId), 'global'],
  ] as const
  for (const [id, source] of candidates) if (id) return { profile: getProfile(id), source }
  return { profile: null, source: 'legacy' }
}
export function resolveProfile(chat?: ChatRow, requireConnection = true) {
  const { profile, source } = selectProfile(chat)
  let connection: ReturnType<typeof resolveApiPreset> | null = null
  try {
    connection = resolveApiPreset(profile?.apiPresetId ?? chat?.apiPresetId ?? null)
  } catch (error) {
    if (requireConnection) throw error
  }
  const model = profile?.model || connection?.model || ''
  if (connection) connection = { ...connection, model }
  const ids = [profile?.promptPresetId, chat?.promptPresetId, getSetting<string>(SETTING_KEYS.defaultPromptPresetId)]
  const presetRow =
    ids
      .filter((id): id is string => !!id)
      .map((id) => db.select().from(promptPresets).where(eq(promptPresets.id, id)).get())
      .find(Boolean) ?? db.select().from(promptPresets).orderBy(asc(promptPresets.createdAt)).get()
  return {
    profile,
    connection,
    model,
    preset: parsePresetWithEnglishDefaults(presetRow?.data ?? {}),
    regex: profile?.regexScripts ?? null,
    imageConnectionId: profile?.imageConnectionId ?? null,
    promptConnectionId: profile?.promptConnectionId ?? null,
    source,
    summary: { baseUrl: connection?.baseUrl ?? '', model, presetName: presetRow?.name ?? '', source },
  }
}
/** 仅通过已打码的连接 DTO 返回摘要，避免把密钥暴露给前端。 */
export function resolvedProfileDTO(chat: ChatRow): ResolvedProfileDTO {
  const result = resolveProfile(chat, false)
  const connection = listApiPresets().find((row) => row.id === result.connection?.id)
  return { ...result, connection: connection ? { ...connection, model: result.model } : null }
}
