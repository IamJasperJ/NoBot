import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { t } from '../i18n'
import { translateMetadata } from '../i18n/metadata'
import { getLanguage } from '../services/settings'

/**
 * 参数校验中间件。校验失败时返回和其他错误一样的格式：
 * { error: { code: 'VALIDATION', message: '字段：原因；…' } }
 */
export const validate = <T extends z.ZodType, K extends 'json' | 'query' | 'param' | 'form'>(target: K, schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      // 失败时按本次请求语言重新格式化，避免修改全局错误映射影响并发请求。
      const issues =
        getLanguage() === 'en'
          ? (schema.safeParse(result.data, { error: z.locales.en().localeError }).error?.issues ?? result.error.issues)
          : result.error.issues
      const message = issues
        .map((i) =>
          t('{field}：{message}', { field: i.path.join('.') || t('参数'), message: translateMetadata(i.message) }),
        )
        .join(getLanguage() === 'en' ? '; ' : '；')
      return c.json({ error: { code: 'VALIDATION', message } }, 400)
    }
  })
