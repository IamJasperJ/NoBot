import { DEFAULT_DIRECTIVE_TEMPLATES, type DirectiveKind } from '@ai-parter/shared'
import type { InstructionsInput } from './index'

/** 默认指令说明模板以 shared 契约为准（英文，保留解析器依赖的标签、属性和台词速记标点；编辑器的「填入默认模板」也用它） */
export { DEFAULT_DIRECTIVE_TEMPLATES }

const commonGuides = {
  cast: '- Enter: <show who="name" at="left|center|right" />; exit: <hide who="name" />.',
  scene:
    '- Change scene: <scene bg="background name" place="location" time="time" />. Only emit when the scene actually changes.',
  choices:
    '- When the player needs to choose, end the reply with 2–4 options:\n<choices>\n- Option one\n- Option two\n</choices>',
  cg: '- Request an illustration for a key scene with <cg prompt="English image description" />. Use sparingly.',
}
const DIRECTIVE_KIND_GUIDES: Record<'shorthand' | 'xml', Partial<Record<DirectiveKind, string>>> = {
  shorthand: {
    ...commonGuides,
    expression:
      '- Put each line of dialogue on its own line: 名字[表情]：「台词」 (name[expression]：「dialogue」), e.g. Alice[joy]：「Welcome back!」. Omit [expression] when unchanged.',
    state:
      '- Put state changes at the end of the reply:\n<state>\npath = value\npath += number\npath -= number\n</state>',
  },
  xml: {
    ...commonGuides,
    expression: '- Dialogue: <say who="name" expr="expression">dialogue</say>. Write narration as plain text.',
    state: '- Put state changes at the end of the reply:\n<state>\npath = value\npath += number\n</state>',
  },
}

export function renderDirectiveInstructions(input: InstructionsInput): string {
  const list = (kind: 'cast' | 'expressions' | 'backgrounds', values: string[]): string =>
    input.lists.includes(kind) ? values.join('、') : ''
  const paths = [...new Set([...Object.keys(input.schema), ...Object.keys(input.vars)])]
  const state: string[] = []
  if (input.kinds.includes('state') && input.lists.includes('vars')) {
    for (const path of paths) {
      const field = Object.hasOwn(input.schema, path) ? input.schema[path] : undefined
      // 只写对模型有用的类型提示：数值范围、数字、列表；文本和标签不写（写「text」只会占 token）
      const type =
        field?.type === 'meter'
          ? `${field.min ?? 0}–${field.max ?? '∞'}`
          : field?.type === 'number'
            ? 'number'
            : field?.type === 'list'
              ? 'list'
              : ''
      const rule = field?.rule ?? (Object.hasOwn(input.rules, path) ? input.rules[path] : '')
      let line = `- ${path}：${[type, rule].filter(Boolean).join(', ')}`
      if (input.valuesInPrompt && Object.hasOwn(input.vars, path)) {
        const value = input.vars[path]
        const rendered = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
        line += `${type || rule ? '; ' : ''}current: ${rendered}`
      }
      state.push(line)
    }
  }
  const replacements: Record<string, string> = {
    vn_kinds: input.kinds
      .map((kind) => DIRECTIVE_KIND_GUIDES[input.style][kind])
      .filter(Boolean)
      .join('\n'),
    vn_cast: list('cast', input.cast),
    vn_expressions: list('expressions', input.expressions),
    vn_backgrounds: list('backgrounds', input.backgrounds),
    vn_state: state.length
      ? `State variables (name: range, update rule${input.valuesInPrompt ? '; current value' : ''}):\n${state.join('\n')}`
      : '',
  }
  return (input.template || DEFAULT_DIRECTIVE_TEMPLATES[input.style])
    .split('\n')
    .filter((line) => {
      for (const match of line.matchAll(/\{\{(vn_\w+)\}\}/g)) if (replacements[match[1]!] === '') return false
      return true
    })
    .map((line) => line.replace(/\{\{(vn_\w+)\}\}/g, (whole, key: string) => replacements[key] ?? whole))
    .join('\n')
    .trim()
}
