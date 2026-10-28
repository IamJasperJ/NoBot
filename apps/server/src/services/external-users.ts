import { and, eq, notExists } from 'drizzle-orm'
import { newId } from '../db/client'
import { systemDatabase } from '../db/system-client'
import { roomMembers, users } from '../db/system-schema'
import { cleanName } from '../lib/input-text'

/** 平台身份按提供方、主人和平台 id 唯一，跨主人不能共享外部成员身份。 */
export function ensureExternalUser(
  provider: string,
  ownerId: string,
  externalId: string,
  name: string,
  now = Date.now(),
) {
  name = cleanName(name)
  const db = systemDatabase()
  const identity = and(
    eq(users.kind, 'external'),
    eq(users.externalProvider, provider),
    eq(users.externalOwnerUserId, ownerId),
    eq(users.externalId, externalId),
  )
  const previous = db.select().from(users).where(identity).get()
  if (previous) return db.update(users).set({ name }).where(eq(users.id, previous.id)).returning().get()
  const id = newId()
  return db
    .insert(users)
    .values({
      id,
      handle: `external-${id}`,
      name,
      // 空串不是密码哈希；所有认证入口在校验密码前后还会检查 kind。
      passwordHash: '',
      kind: 'external',
      externalProvider: provider,
      externalOwnerUserId: ownerId,
      externalId,
      createdAt: now,
    })
    .returning()
    .get()
}
/** 仍在房间中的身份保留；离开记录随身份清理，消息自带的作者快照保留历史。 */
export function cleanupExternalUsers(ownerId: string) {
  const db = systemDatabase()
  return db
    .delete(users)
    .where(
      and(
        eq(users.kind, 'external'),
        eq(users.externalOwnerUserId, ownerId),
        notExists(
          db
            .select()
            .from(roomMembers)
            .where(and(eq(roomMembers.userId, users.id), eq(roomMembers.state, 'active'))),
        ),
      ),
    )
    .run()
}
