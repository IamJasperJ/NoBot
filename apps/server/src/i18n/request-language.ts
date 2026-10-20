import { AsyncLocalStorage } from 'node:async_hooks'

/** 未登录时没有 settings 表，用独立上下文承接请求语言。 */
export const requestLanguage = new AsyncLocalStorage<'zh' | 'en'>()
