/** 优先精确和包含匹配，再按归一化编辑距离评分；同分保持背景库顺序。 */
export function matchBackground<T extends { name: string }>(list: readonly T[], reply: string): T | undefined {
  const normalize = (text: string) => text.trim().toLocaleLowerCase()
  const text = normalize(reply)
  if (!text) return undefined
  const exact = list.find((item) => normalize(item.name) === text)
  if (exact) return exact
  const contained = list.filter((item) => text.includes(normalize(item.name)) || normalize(item.name).includes(text))
  if (contained.length) return contained.sort((a, b) => b.name.length - a.name.length)[0]
  const target = Array.from(text)
  let best: T | undefined
  let bestScore = -1
  for (const item of list) {
    const name = Array.from(normalize(item.name))
    let previous = target.map((_, index) => index + 1)
    previous.unshift(0)
    for (let i = 0; i < name.length; i++) {
      const current = [i + 1]
      for (let j = 0; j < target.length; j++) {
        current.push(Math.min(current[j]! + 1, previous[j + 1]! + 1, previous[j]! + (name[i] === target[j] ? 0 : 1)))
      }
      previous = current
    }
    const score = 1 - previous[target.length]! / Math.max(name.length, target.length)
    if (score > bestScore) {
      bestScore = score
      best = item
    }
  }
  return best
}
