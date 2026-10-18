import { createHash } from 'node:crypto'
import { type ScanEntry, vectorMatches } from '@ai-parter/core'
import type { WorldInfoSettings } from '@ai-parter/shared'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client'
import { apiPresets, lorebookVectors } from '../db/schema'

const responseSchema = z.object({
  data: z.array(z.object({ index: z.number().int().min(0), embedding: z.array(z.number().finite()).min(1) })),
})

/** 请求失败只影响语义匹配，关键词、常驻和粘滞仍可正常激活。 */
export async function matchLoreVectors(
  entries: ScanEntry[],
  history: readonly { content: string }[],
  settings: WorldInfoSettings,
  request: typeof fetch = fetch,
): Promise<string[]> {
  const candidates = entries.filter((entry) => entry.enabled && entry.vectorized && entry.content.trim())
  if (!settings.vectorEnabled || !settings.embeddingConnectionId || !candidates.length || !history.length) return []
  try {
    const connection = db.select().from(apiPresets).where(eq(apiPresets.id, settings.embeddingConnectionId)).get()
    if (!connection) throw new Error('Embedding connection not found')
    const model = settings.embeddingModel || connection.model
    const embed = async (input: string[]) => {
      const response = await request(`${connection.baseUrl.replace(/\/+$/, '')}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
          ...connection.headers,
        },
        body: JSON.stringify({ model, input }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error(`Embedding HTTP ${response.status}`)
      const data = responseSchema.parse(await response.json()).data
      const ordered = input.map((_, index) => data.find((item) => item.index === index)?.embedding)
      if (data.length !== input.length || ordered.some((vector) => !vector))
        throw new Error('Invalid embedding response')
      return ordered as number[][]
    }
    const cached = candidates.map((entry) => {
      const contentHash = createHash('sha256').update(entry.content).digest('hex')
      const key = JSON.stringify([entry.id, contentHash, connection.id, connection.baseUrl, model])
      return {
        entry,
        contentHash,
        key,
        vector: db.select().from(lorebookVectors).where(eq(lorebookVectors.key, key)).get()?.vector,
      }
    })
    const missing = cached.filter((item) => !item.vector)
    const queryText = history
      .slice(-settings.vectorQueryMessages)
      .map((message) => message.content)
      .join('\n')
    const vectors = await embed([...missing.map((item) => item.entry.content), queryText])
    missing.forEach((item, index) => {
      item.vector = vectors[index]!
      db.insert(lorebookVectors)
        .values({ key: item.key, entryId: item.entry.id, contentHash: item.contentHash, model, vector: item.vector })
        .onConflictDoNothing()
        .run()
    })
    return vectorMatches(
      cached.map((item) => ({ id: item.entry.id, vector: item.vector! })),
      vectors.at(-1)!,
      settings.vectorThreshold,
      settings.vectorMaxEntries,
    )
  } catch (error) {
    console.warn('[World Info] Embedding failed:', error)
    return []
  }
}
