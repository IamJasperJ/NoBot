import { DEFAULT_DIRECTIVE_TEMPLATES, DIRECTIVE_KIND_GUIDES } from '@ai-parter/shared'
import type { InstructionsInput } from './index'

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
            ? '数字'
            : field?.type === 'list'
              ? '列表'
              : ''
      const rule = field?.rule ?? (Object.hasOwn(input.rules, path) ? input.rules[path] : '')
      let line = `- ${path}：${[type, rule].filter(Boolean).join('，')}`
      if (input.valuesInPrompt && Object.hasOwn(input.vars, path)) {
        const value = input.vars[path]
        const rendered = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
        line += `${type || rule ? '；' : ''}当前 ${rendered}`
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
      ? `状态变量（名称：取值范围，更新规则${input.valuesInPrompt ? '；当前值' : ''}）：\n${state.join('\n')}`
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
