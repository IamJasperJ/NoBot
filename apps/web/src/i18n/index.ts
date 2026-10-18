import type { Language } from '@ai-parter/shared'
import { create } from 'zustand'
import { queryClient } from '../api/queryClient'
import { en } from './en'

/**
 * 界面双语。用法：t('中文原文')、t('已导入 {n} 张立绘', { n })。
 * - 中文原文就是键；界面语言是英文时查 ./en.ts，查不到就显示中文（i18n.test.ts 会检查遗漏）
 * - 变量用 {名字} 占位，中英文都会替换
 * - 第一个参数必须是单引号字符串字面量（测试靠它提取所有键），不要传变量或模板字符串
 * 语言存在服务器的全局设置里（GET / PUT /api/app-settings），本机再缓存一份，首屏不闪中文
 */

const STORAGE_KEY = 'ai-parter:language'

function cached(): Language {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'zh' || value === 'en') return value
  } catch {
    // localStorage 不可用时用默认
  }
  return 'zh'
}

let current: Language = cached()

export function t(zh: string, vars?: Record<string, string | number>): string {
  const text = current === 'en' ? (en[zh] ?? zh) : zh
  return vars ? text.replace(/\{(\w+)\}/g, (all, key: string) => (key in vars ? String(vars[key]) : all)) : text
}

/** 当前语言；组件里用 useLanguage() 订阅（切换语言时整个应用会重新挂载，一般不需要单独订阅） */
export const useLanguage = create<{ language: Language }>()(() => ({ language: current }))

export function getLanguage(): Language {
  return current
}

/** 切换语言（只改本地；保存到服务器由设置页调用接口） */
export function applyLanguage(language: Language) {
  const changed = current !== language
  current = language
  try {
    localStorage.setItem(STORAGE_KEY, language)
  } catch {
    // 忽略
  }
  document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN'
  // 服务端也会翻译接口数据，必须在界面重新挂载前让所有缓存失效。
  if (changed) void queryClient.invalidateQueries()
  useLanguage.setState({ language })
}

/** 启动时：先用本机缓存，再以服务器上的设置为准（另一台设备可能改过） */
export async function initLanguage() {
  applyLanguage(current)
  try {
    const res = await fetch('/api/app-settings')
    if (!res.ok) return
    const data = (await res.json()) as { language?: Language }
    if (data.language && data.language !== current) applyLanguage(data.language)
  } catch {
    // 后端还没起来时先用缓存
  }
}
