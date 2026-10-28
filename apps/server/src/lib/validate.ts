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
      const message = validationMessage(issues)
      return c.json({ error: { code: 'VALIDATION', message } }, 400)
    }
  })

/** 长度错误用可读字段名；未知字段统一称参数，避免向中文界面泄露英文路径。 */
export function validationMessage(issues: readonly z.core.$ZodIssue[]) {
  return issues
    .map((issue) => {
      const field = String(issue.path.at(-1) ?? '')
      const labels: Record<string, string> = {
        content: t('内容'),
        text: t('内容'),
        reasoning: t('思考内容'),
        name: t('名称'),
        title: t('标题'),
        description: t('描述'),
        label: t('标签'),
      }
      const label = labels[field] ?? t('参数')
      if ((issue.code === 'too_big' || issue.code === 'too_small') && issue.origin === 'string') {
        if (issue.code === 'too_big')
          return t('{field}太长，最多 {max} 字', { field: label, max: Number(issue.maximum) })
        if (issue.minimum === 1) return t('{field}不能为空', { field: label })
        return t('{field}太短，至少 {min} 字', { field: label, min: Number(issue.minimum) })
      }
      return t('{field}：{message}', { field: label, message: translateMetadata(issue.message) })
    })
    .join(getLanguage() === 'en' ? '; ' : '；')
}
