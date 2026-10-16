import type { GenerationLogDTO, GenerationLogSummary } from '@ai-parter/shared'
import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { db, newId } from '../db/client'
import { generationLogs } from '../db/schema'
import { notFound } from '../errors'

/**
 * 请求日志：每次调用模型都记一条（请求体、结果、错误、耗时），用来排查问题，
 * 也用来查看某条消息当时发送的完整 Prompt。只保留最近 MAX_LOGS 条。
 */
const MAX_LOGS = 300

type LogRow = typeof generationLogs.$inferSelect

export interface NewLog {
  chatId?: string | null
  messageId?: string | null
  kind: GenerationLogSummary['kind']
  status: GenerationLogSummary['status']
  model?: string | null
  durationMs?: number | null
  summary?: string
  request?: unknown
  response?: unknown
  report?: unknown
}

export function insertLog(log: NewLog): string {
  const id = newId()
  db.insert(generationLogs)
    .values({
      id,
      chatId: log.chatId ?? null,
      messageId: log.messageId ?? null,
      kind: log.kind,
      status: log.status,
      model: log.model ?? null,
      durationMs: log.durationMs ?? null,
      summary: log.summary ?? '',
      request: log.request ?? null,
      response: log.response ?? null,
      report: log.report ?? null,
      createdAt: Date.now(),
    })
    .run()
  prune()
  return id
}

/** 记录服务器内部错误（没有被业务代码处理的异常） */
export function logError(where: string, err: unknown) {
  try {
    insertLog({
      kind: 'error',
      status: 'error',
      summary: `${where}：${err instanceof Error ? err.message : String(err)}`,
      response: { stack: err instanceof Error ? err.stack : undefined },
    })
  } catch {
    // 记日志本身失败（比如数据库还没初始化）时不能再抛，否则会掩盖原始错误
  }
}

function prune() {
  const cutoff = db
    .select({ createdAt: generationLogs.createdAt })
    .from(generationLogs)
    .orderBy(desc(generationLogs.createdAt))
    .limit(1)
    .offset(MAX_LOGS)
    .get()
  if (cutoff) db.delete(generationLogs).where(lt(generationLogs.createdAt, cutoff.createdAt)).run()
}

function toSummary(r: LogRow): GenerationLogSummary {
  return {
    id: r.id,
    chatId: r.chatId,
    messageId: r.messageId,
    kind: r.kind,
    status: r.status,
    model: r.model,
    durationMs: r.durationMs,
    summary: r.summary,
    createdAt: r.createdAt,
  }
}

export function listLogs(opts: { chatId?: string; limit?: number }): GenerationLogSummary[] {
  return db
    .select()
    .from(generationLogs)
    .where(opts.chatId ? and(eq(generationLogs.chatId, opts.chatId)) : sql`1 = 1`)
    .orderBy(desc(generationLogs.createdAt))
    .limit(Math.min(opts.limit ?? 100, MAX_LOGS))
    .all()
    .map(toSummary)
}

export function getLog(id: string): GenerationLogDTO {
  const r = db.select().from(generationLogs).where(eq(generationLogs.id, id)).get()
  if (!r) throw notFound('日志')
  return { ...toSummary(r), request: r.request, response: r.response, report: r.report }
}

export function clearLogs() {
  db.delete(generationLogs).run()
}
