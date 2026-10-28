import { HttpError } from '../errors'
import { t } from '../i18n'

/** 去除会影响周围文字方向的控制符，保留自然 RTL 文字。 */
export function stripBidi(value: string) {
  return value.replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
}

/** 清洗后再判空，避免视觉空名字进入数据库或触发原始 Zod 异常。 */
export function cleanName(value: string) {
  const name = stripBidi(value).trim()
  if (!name) throw new HttpError(400, 'VALIDATION', t('名称不能为空'))
  return name
}
