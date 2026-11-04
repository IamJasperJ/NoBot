import { describe, expect, test } from 'bun:test'
import { burstDelays, burstSeed, splitBurst } from './burst'

const lines = { mode: 'lines' as const, maxParts: 4 }

describe('渠道拟人分条', () => {
  test('按行去空白，空文本不发送', () => {
    expect(splitBurst(' 第一行内容 \n\n 第二行内容 \n', lines)).toEqual(['第一行内容', '第二行内容'])
    expect(splitBurst(' \n\t', lines)).toEqual([])
  })
  test('长句按句末拆分并合并短句，lines 保留长行', () => {
    const text = '这是第一句话。这是第二句话！这是第三句话？'
    expect(splitBurst(text, { ...lines, mode: 'sentences', maxChars: 10 })).toEqual([
      '这是第一句话。',
      '这是第二句话！',
      '这是第三句话？',
    ])
    expect(splitBurst(text, lines)).toEqual([text])
    expect(splitBurst('第一句话。第二句话。第三句话。', { ...lines, mode: 'sentences', maxChars: 12 })).toEqual([
      '第一句话。第二句话。',
      '第三句话。',
    ])
  })
  test('逗号、顿号、分号不切，英文句号保护数字并吸收闭合符号', () => {
    expect(
      splitBurst('1.5 dollars is the price. Another sentence.', { ...lines, mode: 'sentences', maxChars: 25 }),
    ).toEqual(['1.5 dollars is the price.', 'Another sentence.'])
    const text = '这是长句，里面有、还有；不应该拆开'
    expect(splitBurst(text, { ...lines, mode: 'sentences', maxChars: 5 })).toEqual([text])
    expect(
      splitBurst('He said hello.” Next sentence! Price is 1.5 dollars.', {
        ...lines,
        mode: 'sentences',
        maxChars: 20,
      }),
    ).toEqual(['He said hello.”', 'Next sentence!', 'Price is 1.5 dollars.'])
    expect(splitBurst('这是第一句话……”这是第二句话！？』', { ...lines, mode: 'sentences', maxChars: 10 })).toEqual([
      '这是第一句话……”',
      '这是第二句话！？』',
    ])
  })
  test('模型自己另起一行的短句单独成条，空行不保留', () => {
    expect(splitBurst('2\n\n发个1试探什么呢，有事说事', lines)).toEqual(['2', '发个1试探什么呢，有事说事'])
    expect(splitBurst('草\n这里是完整内容', lines)).toEqual(['草', '这里是完整内容'])
    expect(splitBurst('只有一句\n\n\n', lines)).toEqual(['只有一句'])
  })
  test('按句末切出的短碎片按 Unicode 字符忽略空白标点，只并进同一行', () => {
    const sentences = { ...lines, mode: 'sentences' as const, maxChars: 12 }
    expect(splitBurst('好。这一句话本身就已经很长了！还有后面的另一句话呢。', sentences)).toEqual([
      '好。这一句话本身就已经很长了！',
      '还有后面的另一句话呢。',
    ])
    expect(splitBurst('这一句话本身就已经很长了！𠮷𠮷𠮷。', sentences)).toEqual(['这一句话本身就已经很长了！𠮷𠮷𠮷。'])
    expect(splitBurst('这一句话本身就已经很长了！😀😀😀😀。', sentences)).toEqual([
      '这一句话本身就已经很长了！',
      '😀😀😀😀。',
    ])
  })
  test('超出条数时连续均衡分组', () => {
    const parts = Array.from({ length: 8 }, (_, index) => `${index}这是一句话`)
    expect(splitBurst(parts.join('\n'), lines)).toEqual([
      parts.slice(0, 2).join('\n'),
      parts.slice(2, 4).join('\n'),
      parts.slice(4, 6).join('\n'),
      parts.slice(6, 8).join('\n'),
    ])
    expect(
      splitBurst(['长'.repeat(50), ...Array<string>(6).fill('短短短短')].join('\n'), { ...lines, maxParts: 2 }),
    ).toEqual(['长'.repeat(50), Array<string>(6).fill('短短短短').join('\n')])
  })
  test('同一行拆出的句子被均衡合并回同一条时直接相连，不插换行', () => {
    const line =
      '先说好，无事献殷勤……就算你态度再端正，本鲸今晚也绝对不会再免费帮你重构系统架构了——除非，再添一碗新出锅的白米饭作为杀青报酬！'
    const text = ['第一段旁白，写得稍微长一点也没关系。', '第二段旁白，也是完整的一句话。', line].join('\n')
    expect(splitBurst(text, { mode: 'sentences', maxParts: 1 })).toEqual([text])
    // 分到不同条时各自完整，条内也不会出现「……\n就算」这样的断行。
    for (const part of splitBurst(text, { mode: 'sentences', maxParts: 2 })) expect(part).not.toContain('……\n')
    expect(splitBurst(`好。\n${line}`, { mode: 'sentences', maxParts: 4 }).slice(0, 2)).toEqual([
      '好。',
      '先说好，无事献殷勤……',
    ])
  })
  test('代码块含空行、连续列表和引用均作为整体', () => {
    const blocks = [
      '```ts\nconst value = 1\n\n// 内容。不能拆！\n```',
      '- 第一项内容。\n* 第二项内容！\n1. 第三项内容\n2、第四项内容',
      '> 引用第一句话。\n> 引用第二句话！',
    ]
    expect(splitBurst(blocks.join('\n\n'), { ...lines, mode: 'sentences', maxChars: 5 })).toEqual(blocks)
    expect(splitBurst('```\n未闭合代码\n\n继续', lines)).toEqual(['```\n未闭合代码\n\n继续'])
  })
  test('延迟首项为零、钳位、速度有序，种子可复现', () => {
    const parts = ['首条内容', '中'.repeat(15), '后'.repeat(30), '末'.repeat(40)]
    const seed = burstSeed('message-123')
    const fast = burstDelays(parts, { speed: 'fast' }, seed)
    const medium = burstDelays(parts, { speed: 'medium' }, seed)
    const slow = burstDelays(parts, { speed: 'slow' }, seed)
    expect(fast[0]).toBe(0)
    expect(burstDelays([], { speed: 'fast' }, seed)).toEqual([])
    expect(burstDelays(parts, { speed: 'fast' }, seed)).toEqual(fast)
    expect(burstSeed('message-123')).toBe(seed)
    expect(seed).toBeGreaterThan(0)
    for (let index = 1; index < parts.length; index++) {
      expect(fast[index]!).toBeGreaterThanOrEqual(800)
      expect(slow[index]!).toBeLessThanOrEqual(6000)
      expect(fast[index]!).toBeLessThan(medium[index]!)
      expect(medium[index]!).toBeLessThanOrEqual(slow[index]!)
      expect(Number.isInteger(medium[index])).toBe(true)
    }
    expect(burstDelays(['a', 'b', 'c'.repeat(500)], { speed: 'medium' }, seed)).toEqual([0, 800, 6000])
  })
})
