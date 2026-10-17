import { getLanguage } from '../services/settings'
import { en } from './en'

/**
 * 后端给用户看的文字（错误信息、扩展设置项的标签和说明、内置预设的名字……）的翻译。
 * 以中文原文为键：t('找不到{name}', { name }) —— 界面语言是英文时查 en.ts，查不到就原样返回中文。
 * 变量用 {名字} 占位，中英文都会替换。发给 AI 的提示词不走这里（提示词一律直接写英文）
 */
export function t(zh: string, vars?: Record<string, string | number>): string {
  const text = getLanguage() === 'en' ? (en[zh] ?? zh) : zh
  return vars ? text.replace(/\{(\w+)\}/g, (all, key: string) => (key in vars ? String(vars[key]) : all)) : text
}
