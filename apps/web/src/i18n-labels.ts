import {
  BUILTIN_PROMPTS,
  type BuiltinPromptId,
  type DirectiveKind,
  type GenerationType,
  type PromptSegment,
  type WIActivation,
  type WIPosition,
} from '@ai-parter/shared'
import { t } from './i18n'
import { en } from './i18n/en'

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

/** 世界书报告只保存代码和参数，显示时跟随当前界面语言。 */
export function wiActivationLabel(entry: WIActivation): string {
  if (!entry.activated) {
    switch (entry.skippedCode) {
      case 'no_match':
        return t('未命中关键词')
      case 'cooldown':
        return t('冷却中')
      case 'budget':
        return t('超出预算')
      case 'probability':
        return t('概率未命中')
      case 'group':
        return t('包含组：{group}', { group: entry.skippedParams?.group ?? '' })
      case 'delay':
        return t('等待递归扫描')
      default:
        return ''
    }
  }
  switch (entry.reasonCode) {
    case 'constant':
      return t('常驻')
    case 'sticky':
      return t('粘滞激活')
    case 'vector':
      return t('向量')
    case 'keyword':
      return t('关键词：{key}', { key: entry.reasonParams?.key ?? '' })
    case 'recursive':
      return t('递归：{key}', { key: entry.reasonParams?.key ?? '' })
    default:
      return ''
  }
}

/** 稳定代码用于生成的片段；预设名只在仍等于内置默认值时翻译，旧日志保留原名。 */
export function promptSegmentLabel(segment: PromptSegment): string {
  const code = segment.labelCode
  if (code?.startsWith('preset:')) {
    const id = code.slice('preset:'.length) as BuiltinPromptId
    const original = BUILTIN_PROMPTS[id]?.name
    return original && (segment.label === original || segment.label === en[original])
      ? builtinPromptNames()[id]
      : segment.label
  }
  switch (code) {
    case 'history':
      return t('历史消息')
    case 'examples':
      return t('示例对话')
    case 'example_start':
      return t('示例对话标记')
    case 'author_note':
      return t('作者注释')
    case 'character_note':
      return t('角色备注')
    case 'group_nudge':
      return t('群聊提示')
    case 'continue_nudge':
      return t('续写提示')
    case 'impersonate_nudge':
      return t('代写提示')
    case 'continue_prefill':
      return t('续写预填充')
    case 'impersonate_prefill':
      return t('代写预填充')
    case 'reply_prefill':
      return t('回复预填充')
    case 'new_group':
      return t('新群聊提示')
    case 'new_chat':
      return t('新对话提示')
    case 'stage':
      return t('舞台指令')
    case 'stage_reminder':
      return t('舞台指令提醒')
    case 'world_info':
      return t('世界书：{title}', { title: segment.labelParams?.title ?? '' })
    default:
      return segment.label
  }
}
