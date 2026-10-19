import { rollDice as rollDetailedDice } from '../stage/trpg/dice'

/**
 * 宏替换。数据库里只存原始文本，组装 Prompt 时才替换。
 *
 * 支持：
 *   {{char}} {{user}}         角色名 / 用户名（也兼容旧写法 <BOT> <CHAR> <USER>）
 *   {{time}} {{date}} {{weekday}}
 *   {{random::a::b::c}}      随机选一个（也兼容 {{random:a,b,c}}）
 *   {{roll:1d20}}            掷骰，支持 2d6+3 这种写法
 *   {{group}} {{lastChatMessage}} 群成员 / 最后一条聊天内容
 *   {{original}}             角色卡覆盖时的预设原文
 *   {{outlet::名字}}          世界书插槽
 *   {{stage::变量名}}          当前数值阶段名（没有阶段时为空）
 *   {{名字::参数}}             扩展宏（内置宏优先）
 *   {{newline}}              换行
 *   {{// 注释}}               删除
 */

export interface MacroContext {
  char: string
  user: string
  now: Date
  group?: string
  lastChatMessage?: string
  original?: string
  outlets?: Record<string, string>
  /** 变量当前的阶段名，由调用方按状态 schema 和当前值解析。 */
  stages?: Record<string, string>
  extra?: Record<string, (arg: string) => string>
  /** 随机数种子。同一个种子得到同样的结果，保证预览和真实发送一致 */
  seed: string
}

/** 字符串哈希（FNV-1a），用来生成随机数种子 */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 可复现的伪随机数生成器（mulberry32），返回 [0, 1) */
export function seededRandom(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 掷骰：1d20、2d6+3、d100。格式不对返回 null */
export function rollDice(expr: string, random: () => number): number | null {
  return rollDetailedDice(expr, random)?.total ?? null
}

export function applyMacros(text: string, ctx: MacroContext): string {
  if (!text.includes('{{') && !text.includes('<')) return text

  // 每段文本用自己的种子，避免不同段落的随机结果完全一样
  const random = seededRandom(hashString(`${ctx.seed}|${text}`))

  return text
    .replace(/\{\{\/\/[\s\S]*?\}\}/g, '')
    .replace(/<(BOT|CHAR)>/gi, ctx.char)
    .replace(/<USER>/gi, ctx.user)
    .replace(/\{\{([^{}]*)\}\}/g, (whole, body: string) => {
      const name = body.trim()
      const lower = name.toLowerCase()

      if (lower === 'char') return ctx.char
      if (lower === 'user') return ctx.user
      if (lower === 'group') return ctx.group ?? ''
      if (lower === 'lastchatmessage') return ctx.lastChatMessage ?? ''
      if (lower === 'original') return ctx.original ?? whole
      if (lower.startsWith('outlet::')) {
        const outletName = name.slice(8).trim()
        return ctx.outlets && Object.hasOwn(ctx.outlets, outletName) ? ctx.outlets[outletName]! : ''
      }
      if (lower.startsWith('stage::')) {
        const key = name.slice(7).trim()
        return ctx.stages && Object.hasOwn(ctx.stages, key) ? ctx.stages[key]! : ''
      }
      if (lower === 'newline') return '\n'
      if (lower === 'time') {
        return ctx.now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      }
      if (lower === 'date') {
        return ctx.now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
      }
      if (lower === 'weekday') return ctx.now.toLocaleDateString('zh-CN', { weekday: 'long' })

      if (lower.startsWith('random')) {
        const rest = name.slice('random'.length)
        let options: string[] = []
        if (rest.startsWith('::')) options = rest.slice(2).split('::')
        else if (rest.startsWith(':')) options = rest.slice(1).split(',')
        if (options.length > 0) return options[Math.floor(random() * options.length)]?.trim() ?? ''
        if (lower === 'random' || lower.startsWith('random:')) return whole
      }

      if (lower.startsWith('roll')) {
        const result = rollDice(name.slice(4).replace(/^[:\s]+/, ''), random)
        if (result !== null) return String(result)
        if (lower === 'roll' || lower.startsWith('roll:')) return whole
      }

      const separator = name.indexOf('::')
      const extraName = (separator < 0 ? name : name.slice(0, separator)).trim().toLowerCase()
      const handler = ctx.extra && Object.hasOwn(ctx.extra, extraName) ? ctx.extra[extraName] : undefined
      if (handler) return handler(separator < 0 ? '' : name.slice(separator + 2))

      // 不认识的宏原样保留，方便用户发现写错了
      return whole
    })
}
