import { zValidator } from '@hono/zod-validator'
import type { z } from 'zod'
import { t } from '../i18n'
import { getLanguage } from '../services/settings'

/**
 * 参数校验中间件。校验失败时返回和其他错误一样的格式：
 * { error: { code: 'VALIDATION', message: '字段：原因；…' } }
 */
export const validate = <T extends z.ZodType, K extends 'json' | 'query' | 'param' | 'form'>(target: K, schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const message = validationMessage(result.error.issues)
      return c.json({ error: { code: 'VALIDATION', message } }, 400)
    }
  })

/** 统一生成自然语言，不透出 Zod 类型名、正则、枚举或自定义校验内部细节。 */
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
        role: t('身份'),
        channel: t('频道'),
        startsAt: t('开始时间'),
        maxMembers: t('玩家人数上限'),
        maxSpectators: t('旁观人数上限'),
        username: t('用户名'),
        handle: t('用户名'),
        password: t('密码'),
        oldPassword: t('旧密码'),
        newPassword: t('新密码'),
        durationMinutes: t('持续分钟数'),
        rules: t('房间规则'),
        contentNotes: t('内容提示'),
        current: t('当前先攻位置'),
        order: t('先攻顺序'),
        targetUserId: t('目标用户'),
        to: t('收件人'),
        invite: t('邀请'),
        personaId: t('人设'),
        expiresIn: t('有效时长'),
        maxUses: t('使用次数上限'),
        index: t('选项序号'),
        seq: t('事件序号'),
        members: t('成员'),
        images: t('图片'),
      }
      const label = labels[field] ?? t('参数')
      if ((issue.code === 'too_big' || issue.code === 'too_small') && issue.origin === 'string') {
        if (issue.code === 'too_big')
          return t('{field}太长，最多 {max} 字', { field: label, max: Number(issue.maximum) })
        if (issue.minimum === 1) return t('{field}不能为空', { field: label })
        return t('{field}太短，至少 {min} 字', { field: label, min: Number(issue.minimum) })
      }
      if (
        (issue.code === 'too_big' || issue.code === 'too_small') &&
        (issue.origin === 'array' || issue.origin === 'set')
      ) {
        if (issue.code === 'too_small' && issue.minimum === 1) return t('{field}至少需要一项', { field: label })
        return issue.code === 'too_big'
          ? t('{field}最多允许 {max} 项', { field: label, max: Number(issue.maximum) })
          : t('{field}至少需要 {min} 项', { field: label, min: Number(issue.minimum) })
      }
      if (issue.code === 'too_big') return t('{field}不能大于 {max}', { field: label, max: Number(issue.maximum) })
      if (issue.code === 'too_small') return t('{field}不能小于 {min}', { field: label, min: Number(issue.minimum) })
      if (issue.code === 'invalid_type') {
        if (issue.expected === 'int') return t('{field}必须是整数', { field: label })
        if (issue.expected === 'number') return t('{field}必须是数字', { field: label })
        if (issue.expected === 'string') return t('{field}必须是文字', { field: label })
        if (issue.expected === 'boolean') return t('{field}必须选择是或否', { field: label })
        if (issue.expected === 'array') return t('{field}必须是列表', { field: label })
        return t('{field}无效', { field: label })
      }
      if (issue.code === 'invalid_value') return t('{field}的取值无效', { field: label })
      if (issue.code === 'invalid_format') return t('{field}格式不正确', { field: label })
      if (issue.code === 'unrecognized_keys') return t('{field}包含不支持的字段', { field: label })
      return t('{field}无效', { field: label })
    })
    .join(getLanguage() === 'en' ? '; ' : '；')
}
