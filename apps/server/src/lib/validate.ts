import { zValidator } from '@hono/zod-validator'
import type { z } from 'zod'

/**
 * 参数校验中间件。校验失败时返回和其他错误一样的格式：
 * { error: { code: 'VALIDATION', message: '字段：原因；…' } }
 */
export const validate = <T extends z.ZodType, K extends 'json' | 'query' | 'param' | 'form'>(target: K, schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const message = result.error.issues.map((i) => `${i.path.join('.') || '参数'}：${i.message}`).join('；')
      return c.json({ error: { code: 'VALIDATION', message } }, 400)
    }
  })
