import type { QuickReplySet, QuickReplySetInput, QuickReplyState } from '@nobot/shared'
import { quickReplySetInput } from '@nobot/shared'
import { like, or } from 'drizzle-orm'
import { db, getSetting, newId, setSetting } from '../db/client'
import { settings } from '../db/schema'
import { HttpError, notFound } from '../errors'
import { t } from '../i18n'

const key = 'quickReplies'
export function getQuickReplies(): QuickReplyState {
  return getSetting<QuickReplyState>(key) ?? { sets: [], setIds: [] }
}
export function quickReplyScope(kind: 'chat' | 'character', id: string): string[] {
  return getSetting<string[]>(`quickReplies:${kind}:${id}`) ?? []
}
export function setQuickReplyScope(kind: 'chat' | 'character', id: string, ids: string[]) {
  const known = new Set(getQuickReplies().sets.map((s) => s.id))
  if (ids.some((id) => !known.has(id))) throw notFound(t('快速回复集'))
  setSetting(`quickReplies:${kind}:${id}`, [...new Set(ids)])
}
export function saveQuickReply(input: QuickReplySetInput, id?: string): QuickReplySet {
  const state = getQuickReplies()
  if (id && !state.sets.some((s) => s.id === id)) throw notFound(t('快速回复集'))
  const value = { ...quickReplySetInput.parse(input), id: id ?? newId() }
  if (state.sets.some((s) => s.id !== id && s.name === value.name))
    throw new HttpError(409, 'DUPLICATE_NAME', t('快速回复集名称重复'))
  setSetting(key, { ...state, sets: id ? state.sets.map((s) => (s.id === id ? value : s)) : [...state.sets, value] })
  return value
}
export function deleteQuickReply(id: string) {
  const state = getQuickReplies()
  if (!state.sets.some((s) => s.id === id)) throw notFound(t('快速回复集'))
  // 作用域绑定单独存在设置表中，与集合和全局启用列表一起提交，避免留下悬空引用。
  db.transaction(() => {
    const scopes = db
      .select()
      .from(settings)
      .where(or(like(settings.key, 'quickReplies:chat:%'), like(settings.key, 'quickReplies:character:%')))
      .all()
    for (const scope of scopes) {
      const ids = scope.value as string[]
      if (ids.includes(id))
        setSetting(
          scope.key,
          ids.filter((value) => value !== id),
        )
    }
    setSetting(key, { sets: state.sets.filter((s) => s.id !== id), setIds: state.setIds.filter((x) => x !== id) })
  })
}
export function setGlobalQuickReplies(setIds: string[]) {
  const state = getQuickReplies()
  if (setIds.some((id) => !state.sets.some((s) => s.id === id))) throw notFound(t('快速回复集'))
  setSetting(key, { ...state, setIds: [...new Set(setIds)] })
  return getQuickReplies()
}
