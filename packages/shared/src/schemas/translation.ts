/**
 * F4 翻译（内置扩展 translate）的契约。对照酒馆的 Chat Translation 扩展：
 * - 角色回复：原文（模型的语言）不动，译文另存，显示时可切换
 * - 我的输入：发送前把我写的话翻成「模型语言」，发给模型的是译文，界面仍显示我写的原文
 * 两种情况都存在 meta.translation，用 direction 区分哪一份是正文。
 */

export const TRANSLATION_PROVIDERS = ['llm', 'google', 'deepl', 'deeplx', 'libre', 'lingva'] as const
export type TranslationProvider = (typeof TRANSLATION_PROVIDERS)[number]

/** 自动模式（同酒馆）：不自动 / 翻译回复 / 翻译我的输入 / 都翻译 */
export const TRANSLATION_AUTO_MODES = ['none', 'responses', 'inputs', 'both'] as const
export type TranslationAutoMode = (typeof TRANSLATION_AUTO_MODES)[number]

export interface MessageTranslation {
  /**
   * display：content 是原文，text 是给我看的译文（回复的翻译、手动翻译）
   * source：content 是发给模型的译文，text 是我写的原文（「翻译我的输入」）
   */
  direction: 'display' | 'source'
  /** text 的语言代码（如 zh-CN、en） */
  lang: string
  provider: TranslationProvider
  text: string
  /** 思考过程的译文（开启「翻译思考过程」时） */
  reasoning?: string
  /** 翻译时 content 的哈希；之后正文被编辑，哈希对不上，界面提示译文已过期 */
  sourceHash: string
  /** 自动翻译生成的（区别于手动） */
  auto?: boolean
}

/** 常用语言（界面下拉用）；label 是该语言的自称，不翻译 */
export const TRANSLATION_LANGUAGES: { code: string; label: string }[] = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' },
  { code: 'it', label: 'Italiano' },
  { code: 'ru', label: 'Русский' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'th', label: 'ไทย' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'ar', label: 'العربية' },
]
