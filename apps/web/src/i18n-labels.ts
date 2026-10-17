import type { BuiltinPromptId, DirectiveKind, GenerationType, WIPosition } from '@ai-parter/shared'
import { t } from './i18n'

// 共享契约里的标签保持原样；界面每次渲染时按当前语言取显示文字。
export const generationTypeLabels = (): Record<GenerationType, string> => ({
  normal: t('普通发送'),
  continue: t('续写'),
  impersonate: t('代写'),
  swipe: t('滑动生成'),
  regenerate: t('重新生成'),
  quiet: t('后台生成'),
})

export const wiPositionLabels = (): Record<WIPosition, string> => ({
  before_char: t('角色定义之前'),
  after_char: t('角色定义之后'),
  before_em: t('示例对话之前'),
  after_em: t('示例对话之后'),
  before_an: t('作者注释上方'),
  after_an: t('作者注释下方'),
  at_depth: t('按深度插入'),
  outlet: t('Outlet（宏引用）'),
})

export const directiveKindLabels = (): Record<DirectiveKind, string> => ({
  expression: t('表情'),
  cast: t('上下台'),
  scene: t('场景'),
  state: t('变量'),
  choices: t('选项'),
  cg: 'CG',
  combat: t('战斗'),
  audio: t('音频'),
})

// 只翻译内置条目的元数据说明；用户可以改写的 block.name 仍按原值显示。
export const builtinPromptNames = (): Record<BuiltinPromptId, string> => ({
  main: t('主提示词'),
  auxiliary: t('辅助提示词'),
  enhance_definitions: t('增强定义'),
  post_history: t('历史后指令'),
  wi_before: t('世界书（角色前）'),
  char_description: t('角色描述'),
  char_personality: t('角色性格'),
  scenario: t('场景'),
  wi_after: t('世界书（角色后）'),
  persona: t('用户人设'),
  examples: t('示例对话'),
  history: t('聊天记录'),
})
