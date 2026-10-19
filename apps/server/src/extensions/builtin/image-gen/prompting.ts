import { toDisplayText } from '@nobot/core/stage'
import { cleanPrompt, type Mode, promptInstruction, replaceTemplate } from './modes'

/** 提炼只读取读者可见的剧情，避免把舞台协议当作输出范例。 */
export function imageSourceText(text: string, names: string[]): string {
  return toDisplayText(text, { knownNames: names, speaker: 'plain' }).trim()
}

/** 指定消息独立放在模板之后，兼容未写输入宏的酒馆模板并固定本次绘制对象。 */
export function imageInstruction(
  mode: Mode,
  template: unknown,
  style: 'tags' | 'natural',
  values: { char: string; user: string; input: string },
): string {
  let instruction = replaceTemplate(promptInstruction(mode, template, style), values)
  const embedsInput = typeof template === 'string' && /{{input}}|\{0\}/.test(template)
  if (values.input.trim() && !embedsInput) {
    const label = ['last', 'message', 'scene'].includes(mode)
      ? 'Illustrate this specific message, even if newer messages have arrived:'
      : mode === 'free'
        ? 'Expand this image description:'
        : 'Additional visual direction:'
    instruction += `\n\n${label}\n${values.input}`
  }
  return instruction
}

/** 酒馆普通提炼只保留英文绘图语法；有舞台续写时仅接受它前面的提示词，不能删掉标签后留下剧情。 */
export function generatedPrompt(text: string, minimal = false): string {
  if (minimal) return cleanPrompt(text, true)
  const withoutThinking = text.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '')
  const boundary = withoutThinking.search(/<(?:scene|show|hide|say|expr|cg|sfx|bgm|state|choices)\b/i)
  const prompt = boundary < 0 ? withoutThinking : withoutThinking.slice(0, boundary)
  return cleanPrompt(
    prompt
      .replace(/^\s*\[?[^\n:]{1,100} sends a picture that contains:\s*/i, '')
      .normalize('NFD')
      .replace(/\P{ASCII}/gu, ' '),
  )
}
