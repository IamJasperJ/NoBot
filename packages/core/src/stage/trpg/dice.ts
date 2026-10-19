import type { DiceResult } from '@nobot/shared'

interface Term {
  sign: number
  count: number
  sides: number
  mode?: string
  limit: number
  text: string
}

/** 先完整验证再消耗随机数，避免非法表达式改变后续检定的随机序列。 */
export function rollDice(expression: string, random: () => number): DiceResult | null {
  let source = expression.toLowerCase().replace(/\s/g, '')
  const alias = /(?:advantage|disadvantage|adv|dis)$/.exec(source)?.[0]
  let advantage: DiceResult['advantage']
  if (alias) {
    source = source.slice(0, -alias.length)
    if (!/^1?d20(?:[+-]\d+)*$/.test(source)) return null
    advantage = alias.startsWith('adv') ? 'advantage' : 'disadvantage'
    source = source.replace(/^1?d20/, advantage === 'advantage' ? '2d20kh1' : '2d20kl1')
  }
  const parts = source.match(/[+-]?[^+-]+/g)
  if (!parts || parts.join('') !== source || parts.length > 20) return null
  const terms: Term[] = []
  for (const part of parts) {
    const match = /^([+-]?)(?:(\d*)d(\d+|%)(?:(kh|kl|dh|dl)(\d+))?|(\d+))$/.exec(part)
    if (!match) return null
    const sign = match[1] === '-' ? -1 : 1
    const sides = match[3] === '%' ? 100 : Number(match[3] ?? 0)
    if (match[3] !== undefined && (sides < 2 || sides > 1000)) return null
    const count = sides ? Number(match[2] || 1) : 0
    const mode = match[4]
    const limit = mode ? Number(match[5]) : count
    if (sides && (count < 1 || count > 100 || sides < 2 || sides > 1000 || limit > count)) return null
    const value = Number(match[6] ?? 0)
    if (!Number.isSafeInteger(value)) return null
    terms.push({
      sign,
      count,
      sides,
      mode,
      limit,
      text: sides ? `${count}d${sides}${mode ? `${mode}${limit}` : ''}` : String(value),
    })
  }
  const result: DiceResult = { expression: '', groups: [], modifier: 0, total: 0 }
  for (const [index, term] of terms.entries()) {
    result.expression += `${term.sign < 0 ? '-' : index ? '+' : ''}${term.text}`
    if (!term.sides) {
      result.modifier += term.sign * Number(term.text)
      continue
    }
    const rolls = Array.from({ length: term.count }, () => ({
      value: 1 + Math.floor(random() * term.sides),
      kept: true,
    }))
    if (term.mode) {
      const ranked = rolls.map((roll, i) => ({ value: roll.value, i }))
      ranked.sort((a, b) => (term.mode?.endsWith('h') ? b.value - a.value : a.value - b.value))
      const selected = new Set(ranked.slice(0, term.limit).map(({ i }) => i))
      for (const [i, roll] of rolls.entries()) roll.kept = term.mode.startsWith('k') === selected.has(i)
    }
    result.groups.push({ sides: term.sides, rolls })
    result.total += term.sign * rolls.reduce((sum, roll) => sum + (roll.kept ? roll.value : 0), 0)
  }
  result.total += result.modifier
  if (!Number.isSafeInteger(result.total) || !Number.isSafeInteger(result.modifier)) return null
  const d20 = result.groups.filter((group) => group.sides === 20)
  const kept = d20[0]?.rolls.filter((roll) => roll.kept)
  if (d20.length === 1 && kept?.length === 1) {
    if (kept[0]!.value === 20) result.natural = 'crit'
    if (kept[0]!.value === 1) result.natural = 'fumble'
  }
  if (advantage) result.advantage = advantage
  return result
}

/** 用英文给模型展示实际点数；减去的骰组保留正点数，符号从规范表达式读取。 */
export function formatDice(result: DiceResult): string {
  const diceTerms = result.expression.match(/[+-]?\d+d\d+(?:(?:kh|kl|dh|dl)\d+)?/g) ?? []
  const detail = result.groups.map((group, i) => {
    const values = group.rolls.map((roll) => (roll.kept ? String(roll.value) : `~~${roll.value}~~`)).join(', ')
    return `${diceTerms[i]?.startsWith('-') ? '-' : i ? '+' : ''}(${values})`
  })
  if (result.modifier) detail.push(`${result.modifier > 0 ? '+' : ''}${result.modifier}`)
  return `${result.expression} = ${result.total} (${detail.join(' ') || '0'})`
}
