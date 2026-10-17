import { DEFAULT_DIRECTIVE_REMINDERS, DEFAULT_DIRECTIVE_TEMPLATES, type DirectiveKind } from '@ai-parter/shared'
import type { InstructionsInput } from './index'

/** 默认指令说明模板以 shared 契约为准（英文，保留解析器依赖的标签、属性和台词速记标点；编辑器的「填入默认模板」也用它） */
export { DEFAULT_DIRECTIVE_TEMPLATES }

const commonGuides = {
  cast: '- Enter: you MUST write <show who="name" at="left|center|right" outfit="outfit name" />; exit: <hide who="name" />. On clothing changes, write show again with the new outfit. Only use listed outfit names; omit outfit for the default clothing.',
  scene:
    '- Change scene: <scene bg="background name" place="location" time="time" />. You MUST emit this when location or time changes, and in the first reply if no scene exists yet. Copy an available background name exactly when suitable; otherwise use a short new name in the conversation language (location plus necessary time or mood); a new background will be generated automatically.',
  cg: '- Request an illustration for a key scene with <cg prompt="English image description" />. Use sparingly.',
}
const DIRECTIVE_KIND_GUIDES: Record<'shorthand' | 'xml', Partial<Record<DirectiveKind, string>>> = {
  shorthand: {
    ...commonGuides,
    expression:
      '- Put each line of dialogue on its own line: you MUST format EVERY spoken sentence as name[expression]：「dialogue」, e.g. Alice[joy]：「Welcome back!」. Always include an expression from Available expressions, even when unchanged.',
    state:
      '- You MUST put state changes at the end of the reply:\n<state>\npath = value\npath += number\npath -= number\n</state>',
  },
  xml: {
    ...commonGuides,
    expression:
      '- You MUST format EVERY spoken sentence as <say who="name" expr="expression">dialogue</say>. Always include expr from Available expressions. Write narration as plain text.',
    state: '- You MUST put state changes at the end of the reply:\n<state>\npath = value\npath += number\n</state>',
  },
}

export function renderDirectiveInstructions(input: InstructionsInput): string {
  const list = (kind: 'cast' | 'expressions' | 'backgrounds', values: string[]): string =>
    input.lists.includes(kind) ? values.join(', ') : ''
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
      let line = `- ${path}: ${[type, rule].filter(Boolean).join(', ')}`
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
      .map((kind) => guide(input, kind))
      .filter(Boolean)
      .join('\n'),
    vn_outfits: input.lists.includes('outfits')
      ? Object.entries(input.outfits)
          .map(([name, outfits]) => {
            const names = [...new Set(outfits.filter(Boolean))]
            return names.length ? `${name}: ${names.join(', ')}` : ''
          })
          .filter(Boolean)
          .join('; ')
          .replace(/^(.+)$/, 'Available outfits: $1')
      : '',
    vn_example: example(input),
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

function guide(input: InstructionsInput, kind: DirectiveKind): string {
  if (kind === 'choices')
    return input.choicesMode === 'always'
      ? '- You MUST end EVERY reply with 2–4 actionable options: <choices>\n- Option one\n- Option two\n</choices>'
      : '- Only when the player faces a choice, you MUST end the reply with 2–4 actionable options: <choices>\n- Option one\n- Option two\n</choices>'
  if (kind === 'combat') return '- Use <combat>...</combat> for combat directives when combat occurs.'
  if (kind === 'audio') return '- Use <sfx name="sound" /> or <bgm name="music" /> when audio changes.'
  return DIRECTIVE_KIND_GUIDES[input.style][kind] ?? ''
}

function example(input: InstructionsInput): string {
  const who = input.cast[0] || 'Alice'
  const bg = input.backgrounds[0] || 'Classroom'
  const expression = input.expressions.includes('joy') ? 'joy' : input.expressions[0] || 'neutral'
  const second = input.expressions.includes('neutral') ? 'neutral' : input.expressions[1] || expression
  const outfit = input.outfits[who]?.find(Boolean)
  const lines: string[] = []
  if (input.kinds.includes('scene')) lines.push(`<scene bg="${bg}" time="evening" />`)
  if (input.kinds.includes('cast'))
    lines.push(`<show who="${who}" at="center"${outfit ? ` outfit="${outfit}"` : ''} />`)
  lines.push('Soft light fills the room.')
  if (input.kinds.includes('expression')) {
    for (const [expr, text] of [
      [expression, 'Welcome back.'],
      [second, 'Shall we begin?'],
    ]) {
      lines.push(
        input.style === 'xml' ? `<say who="${who}" expr="${expr}">${text}</say>` : `${who}[${expr}]：「${text}」`,
      )
    }
  }
  if (input.kinds.includes('cg')) lines.push('<cg prompt="Soft morning light in a classroom" />')
  if (input.kinds.includes('combat')) lines.push('<combat>Encounter begins</combat>')
  if (input.kinds.includes('audio')) lines.push('<sfx name="bell" />')
  const path = Object.keys(input.schema)[0] || Object.keys(input.vars)[0]
  if (input.kinds.includes('state') && path) {
    // 数值变量示范增量写法；把当前值原样写回去等于什么都没改，模型会照着学
    const field = input.schema[path]
    const current = input.vars[path] ?? field?.init
    const numeric = field?.type === 'meter' || field?.type === 'number' || typeof current === 'number'
    lines.push(
      numeric ? `<state>${path} += 2</state>` : `<state>${path} = ${JSON.stringify(current ?? 'new value')}</state>`,
    )
  }
  if (input.kinds.includes('choices')) lines.push('<choices>\n- Enter the room\n- Wait outside\n</choices>')
  while (lines.join('\n').split('\n').length < 4) lines.push('A quiet moment passes.')
  // 超过 10 行时先去掉次要的示例（插图、战斗、音效），不把它们拼到别的行上，免得模型学成同一行连写
  while (lines.join('\n').split('\n').length > 10) {
    const index = lines.findIndex(
      (line) => line.startsWith('<cg ') || line.startsWith('<combat>') || line.startsWith('<sfx '),
    )
    if (index < 0) break
    lines.splice(index, 1)
  }
  return lines.join('\n')
}

/** 提醒保持每种指令一行，避免重复完整清单占用上下文。 */
export function renderDirectiveReminder(input: InstructionsInput & { reminderTemplate: string }): string {
  const rulesByKind: Record<DirectiveKind, string> = {
    expression:
      input.style === 'xml'
        ? '- EVERY spoken sentence MUST use <say who="name" expr="expression">dialogue</say>; select an available expression.'
        : '- EVERY spoken sentence MUST use name[expression]：「dialogue」; select an available expression.',
    cast: '- Enter with <show who="name" outfit="listed outfit" />; exit with <hide who="name" />. Repeat show when changing clothing; omit outfit for default clothing.',
    scene:
      '- Use <scene bg="name" place="location" time="time" /> on location/time changes and if no scene exists. Copy library names exactly, or use a short new location name in the conversation language.',
    state: '- Update changed variables with <state>path = value</state> before choices.',
    choices:
      input.choicesMode === 'always'
        ? '- End EVERY reply with <choices> containing 2–4 options, one per line prefixed with "- ".'
        : '- When the player faces a choice, end with <choices> containing 2–4 options, one per line prefixed with "- ".',
    cg: '- For a key illustration, use <cg prompt="English image description" /> sparingly.',
    combat: '- Use <combat>...</combat> for combat directives when combat occurs.',
    audio: '- Use <sfx name="sound" /> or <bgm name="music" /> when audio changes.',
  }
  const rules = input.kinds.map((kind) => rulesByKind[kind]).join('\n')
  return (input.reminderTemplate || DEFAULT_DIRECTIVE_REMINDERS[input.style])
    .split('\n')
    .filter((line) => rules || !line.includes('{{vn_rules}}'))
    .map((line) => line.replaceAll('{{vn_rules}}', rules))
    .join('\n')
    .trim()
}
