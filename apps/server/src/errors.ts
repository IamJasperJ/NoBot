import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { t } from './i18n'

/**
 * 业务错误。在 service 里直接 throw，由 app.onError 统一转成
 * { error: { code, message } } 返回给前端。message 是按当前界面语言翻译的用户提示。
 */
export class HttpError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

export const notFound = (what: string) => new HttpError(404, 'NOT_FOUND', t('{what}不存在', { what }))

/** 核心层不依赖应用语言，服务端在错误边界保留预算数值并翻译。 */
export function promptBudgetMessage(message: string): string {
  const match = /^固定提示词超出预算 (\d+) token（预算 (\d+) token）$/.exec(message)
  return match
    ? t('固定提示词超出预算 {over} token（预算 {budget} token）', { over: match[1]!, budget: match[2]! })
    : message
}

/** 外部解析器的固定错误在服务端本地化；额外诊断信息保留原文。 */
export function cardParseMessage(message: string): string {
  switch (message) {
    case '角色卡内容不是 JSON 对象':
      return t('角色卡内容不是 JSON 对象')
    case '角色卡缺少 data 字段':
      return t('角色卡缺少 data 字段')
    case '这个 JSON 不是角色卡（没有 description、first_mes 等角色字段）':
      return t('这个 JSON 不是角色卡（没有 description、first_mes 等角色字段）')
    case '角色卡缺少名字':
      return t('角色卡缺少名字')
    case '这张 PNG 里没有角色卡数据':
      return t('这张 PNG 里没有角色卡数据')
    case 'PNG 里的角色卡数据无法解析':
      return t('PNG 里的角色卡数据无法解析')
    case '文件既不是 PNG 角色卡，也不是有效的 JSON':
      return t('文件既不是 PNG 角色卡，也不是有效的 JSON')
    default: {
      const prefix = '角色卡字段不合法：'
      return message.startsWith(prefix)
        ? t('角色卡字段不合法：{detail}', { detail: message.slice(prefix.length) })
        : message
    }
  }
}
