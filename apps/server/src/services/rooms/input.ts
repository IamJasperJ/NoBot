import { roomSendInput } from '@nobot/shared'
import { z } from 'zod'
import { HttpError } from '../../errors'
import { t } from '../../i18n'

export const roomEditInput = z.object({ content: roomSendInput.shape.text })

export function validateEdit(content: unknown): string {
  const parsed = roomSendInput.shape.text.safeParse(content)
  if (!parsed.success) throw new HttpError(400, 'VALIDATION', t('编辑内容不能为空，且不能超过 100000 字符'))
  return parsed.data
}

const attempts = new Map<string, number[]>()
/** 发送与有效编辑共用窗口；顺便清除过期用户，避免闲置键无限累积。 */
export function rateLimitMessage(key: string, now = Date.now(), editing = false) {
  for (const [id, times] of attempts) if (!times.some((time) => time > now - 60000)) attempts.delete(id)
  const recent = (attempts.get(key) ?? []).filter((n) => n > now - 60000)
  if (recent.length >= 30)
    throw new HttpError(
      429,
      'RATE_LIMITED',
      editing ? t('编辑过于频繁，请稍后重试') : t('消息发送过于频繁，请稍后重试'),
    )
  recent.push(now)
  attempts.set(key, recent)
}
