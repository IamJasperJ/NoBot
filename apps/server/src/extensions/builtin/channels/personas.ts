import type { ChannelActorDTO, ChannelBindingDTO } from '@nobot/shared'
import { and, eq } from 'drizzle-orm'
import { db, getSetting, setSetting } from '../../../db/client'
import { channelActors, personas } from '../../../db/schema'
import { systemDatabase } from '../../../db/system-client'
import { roomMembers, users } from '../../../db/system-schema'
import { updateChat } from '../../../services/chats'
import { createPersona, listPersonas, updatePersona as updateLocalPersona } from '../../../services/personas'
import { updatePersona } from '../../../services/rooms'
import { currentUser, runAsUser } from '../../../user-context'
import { asChannelActor } from './rooms'
import { accountRow } from './store'

/** 平台昵称跟随改名；显式选择的人设保留，不被下一条平台消息覆盖。 */
export function syncActorPersona(binding: ChannelBindingDTO, actor: ChannelActorDTO) {
  const config = accountRow(binding.accountId).config
  const mode = binding.personaMode ?? config.personaMode
  if (!binding.roomId) {
    if (
      actor.linkedUserId === currentUser().id &&
      !actor.personaId &&
      (mode === 'platform-name' || actor.personaName)
    ) {
      const key = `channels:platform-persona:${actor.id}`
      const id = getSetting<string>(key)
      const old = id ? db.select().from(personas).where(eq(personas.id, id)).get() : undefined
      const name = actor.personaName ?? actor.displayName,
        description = actor.personaDescription ?? ''
      const persona = old ?? createPersona({ name, description })
      if (!old) setSetting(key, persona.id)
      else if (old.name !== name || old.description !== description) updateLocalPersona(old.id, { name, description })
      updateChat(binding.chatId, { personaId: persona.id })
      return
    }
    const personaId =
      mode === 'global' && config.globalPersonaId && (!actor.personaId || config.personaLocked)
        ? config.globalPersonaId
        : actor.personaId
    if (personaId && actor.linkedUserId === currentUser().id) updateChat(binding.chatId, { personaId })
    return
  }
  const userId = actor.linkedUserId ?? actor.externalUserId
  if (!userId) return
  const member = systemDatabase()
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, binding.roomId), eq(roomMembers.userId, userId)))
    .get()
  if (!member) return
  let name: string | undefined, description: string | undefined
  if (mode === 'global' && config.globalPersonaId && (!actor.personaName || config.personaLocked)) {
    const persona = db.select().from(personas).where(eq(personas.id, config.globalPersonaId)).get()
    if (persona) {
      name = persona.name
      description = persona.description
    }
  } else if (actor.personaName) {
    name = actor.personaName
    description = actor.personaDescription ?? ''
  } else if (mode === 'platform-name') {
    name = actor.displayName
    description = ''
  }
  if (name !== undefined && (member.personaName !== name || member.personaDescription !== description))
    asChannelActor(binding, actor, () => updatePersona(binding.roomId!, { name, description }))
}
export function chooseActorPersona(binding: ChannelBindingDTO, actor: ChannelActorDTO, input: string) {
  const owner = currentUser()
  if (actor.linkedUserId) {
    const user = systemDatabase()
      .select()
      .from(users)
      .where(and(eq(users.id, actor.linkedUserId), eq(users.kind, 'normal'), eq(users.disabled, false)))
      .get()
    if (!user) return null
    return runAsUser(user, () => {
      const available = listPersonas()
      const selected = available.find((p) => p.id === input || p.name === input)
      if (!selected) return available.map((p) => `${p.id}: ${p.name}`).join('\n')
      const result = binding.roomId
        ? updatePersona(binding.roomId, { personaId: selected.id })
        : updateChat(binding.chatId, { personaId: selected.id })
      runAsUser(owner, () =>
        db
          .update(channelActors)
          .set({ personaId: selected.id, personaName: selected.name, personaDescription: selected.description })
          .where(eq(channelActors.id, actor.id))
          .run(),
      )
      return result
    })
  }
  const [name, description = ''] = input.split('|').map((s) => s.trim())
  if (!name || !binding.roomId) return null
  db.update(channelActors)
    .set({ personaName: name, personaDescription: description })
    .where(eq(channelActors.id, actor.id))
    .run()
  return asChannelActor(binding, actor, () => updatePersona(binding.roomId!, { name, description }))
}
