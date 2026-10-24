import { roomsApi, scopeForChat } from '../api/rooms'
import { t } from '../i18n'
import { runQuickReply } from '../quick-replies/logic'
import { notifyUserSent } from './context'
import { getCommand, listCommands, registerCommand, type SlashCommand } from './registry'
import { requireChat } from './run'

let initialized = false
export function registerBuiltins() {
  if (initialized) return
  initialized = true
  const add = (command: SlashCommand) => registerCommand(command)
  const plain = (name: string, description: () => string, run: SlashCommand['run'], unnamed?: () => string) =>
    add({
      name,
      get description() {
        return description()
      },
      args: [],
      ...(unnamed
        ? {
            get unnamed() {
              return { description: unnamed() }
            },
          }
        : {}),
      run,
    })
  plain(
    'help',
    () => t('显示命令帮助'),
    async (_ctx, _args, text) => {
      const entries = text ? [getCommand(text)] : [...new Set(listCommands().map((s) => s.command))]
      if (entries.some((e) => !e)) throw new Error(t('未知命令：{name}', { name: text }))
      const result = entries
        .map((c) =>
          c
            ? `/${c.name}: ${c.description}\n${c.args.map((a) => `${a.name}: ${a.description}`).join('\n')}${c.unnamed ? `\n${c.unnamed.description}` : ''}`
            : '',
        )
        .join('\n')
      _ctx.notify(result)
      return result
    },
    () => t('命令名'),
  )
  for (const role of ['user', 'system'] as const) {
    plain(
      role === 'user' ? 'send' : 'sys',
      () => (role === 'user' ? t('发送用户消息，不生成回复') : t('插入旁白消息')),
      async (ctx, _args, text) => {
        const id = requireChat(ctx)
        await ctx.api.appendMessage(id, role, text)
        await ctx.refresh()
        if (role === 'user') notifyUserSent(ctx)
        return text
      },
      () => t('消息文本'),
    )
  }
  plain(
    'trigger',
    () => t('让角色回复'),
    async (ctx, _args, text) => {
      const chatId = requireChat(ctx)
      let speakerId: string | undefined
      if (text) {
        const page = await ctx.api.getChatPage(chatId)
        const members =
          page.group?.members ?? (page.chat.characterId ? [await ctx.api.getCharacter(page.chat.characterId)] : [])
        const matches = members.filter((m) => m.name === text)
        if (matches.length !== 1) throw new Error(t('角色名字不存在或不唯一'))
        const match = matches[0]!
        speakerId = 'characterId' in match ? match.characterId : match.id
      }
      await ctx.generate(chatId, { mode: 'trigger', ...(speakerId ? { speakerId } : {}) })
    },
    () => t('角色名'),
  )
  for (const name of ['continue', 'regen', 'swipe'] as const) {
    plain(
      name,
      () => (name === 'continue' ? t('续写最后回复') : name === 'regen' ? t('重新生成回复') : t('切换下一个回复')),
      async (ctx) => {
        const chatId = requireChat(ctx)
        const page = await ctx.api.getChatPage(chatId)
        const target = page.messages.findLast((m) => m.role === 'assistant')
        if (!target) throw new Error(t('没有角色回复'))
        if (name === 'swipe') {
          await ctx.api.swipe(chatId, { messageId: target.id, direction: 1 })
          await ctx.refresh()
        } else await ctx.generate(chatId, { mode: name === 'regen' ? 'regenerate' : 'continue', targetId: target.id })
      },
    )
  }
  plain(
    'roll',
    () => t('掷骰并插入旁白'),
    async (ctx, _args, text) => {
      const chatId = requireChat(ctx)
      const roomId = scopeForChat(chatId)
      const match = /\s+(public|gm|blind|self)$/.exec(text)
      const visibility = match?.[1] as 'public' | 'gm' | 'blind' | 'self' | undefined
      const { result } = roomId
        ? await roomsApi.roll(roomId, { expression: match ? text.slice(0, match.index).trim() : text, visibility })
        : await ctx.api.roll(chatId, text)
      await ctx.refresh()
      return result
    },
    () => t('掷骰表达式，例如 2d6+3'),
  )
  plain(
    'bg',
    () => t('按名字设置会话背景'),
    async (ctx, _args, text) => {
      const matches = (await ctx.api.listBackgrounds()).filter((bg) => bg.name === text)
      if (matches.length !== 1) throw new Error(t('背景名字不存在或不唯一'))
      await ctx.api.updateChat(requireChat(ctx), { backgroundId: matches[0]!.id, backgroundPinned: true })
      await ctx.refresh()
      return text
    },
    () => t('背景名'),
  )
  plain(
    'autobg',
    () => t('自动选择背景'),
    async (ctx) => {
      const result = await ctx.api.autoBackground(requireChat(ctx))
      await ctx.refresh()
      return result.reply
    },
  )
  plain(
    'summarize',
    () => t('总结当前剧情'),
    async (ctx) => {
      const result = await ctx.api.runSummary(requireChat(ctx))
      await ctx.refresh()
      return JSON.stringify(result)
    },
  )
  add({
    name: 'qr',
    get description() {
      return t('执行快速回复')
    },
    args: [
      {
        name: 'set',
        type: 'string',
        get description() {
          return t('快速回复集名称')
        },
      },
      {
        name: 'label',
        type: 'string',
        get description() {
          return t('按钮标签')
        },
      },
    ],
    get unnamed() {
      return { description: t('按钮标签') }
    },
    run: async (ctx, args, text) => {
      const sets = args.set
        ? (await ctx.api.listQuickReplySets()).sets.filter((s) => s.name === args.set)
        : await ctx.getActiveSets()
      const matches = sets.flatMap((set) =>
        set.buttons.filter((b) => b.label === (args.label ?? text)).map((qr) => ({ set, qr })),
      )
      if (matches.length !== 1) throw new Error(t('快速回复不存在或不唯一'))
      return runQuickReply(matches[0]!.qr, ctx, matches[0]!.set)
    },
  })
  add({
    name: 'setvar',
    get description() {
      return t('设置会话变量')
    },
    args: [
      {
        name: 'name',
        type: 'string',
        required: true,
        get description() {
          return t('变量名')
        },
      },
    ],
    get unnamed() {
      return { description: t('变量值') }
    },
    run: async (ctx, args, text) => {
      let value: unknown = text
      try {
        value = JSON.parse(text)
      } catch {
        /* 普通文本保留为字符串。 */
      }
      await ctx.api.setVars(requireChat(ctx), { [args.name!]: value })
      await ctx.refresh()
      return text
    },
  })
  plain(
    'getvar',
    () => t('读取会话变量'),
    async (ctx, _args, text) => {
      const value = (await ctx.api.getChatPage(requireChat(ctx))).vars[text]
      return typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
    },
    () => t('变量名'),
  )
  plain(
    'echo',
    () => t('显示提示'),
    async (ctx, _args, text) => {
      ctx.notify(text)
      return text
    },
    () => t('提示文字'),
  )
  plain(
    'delay',
    () => t('等待毫秒数'),
    async (_ctx, _args, text) => {
      const ms = Number(text)
      if (!text || !Number.isFinite(ms) || ms < 0 || ms > 2_147_483_647)
        throw new Error(t('等待时间必须是有效的非负毫秒数'))
      await new Promise((resolve) => setTimeout(resolve, ms))
    },
    () => t('毫秒数'),
  )
  plain(
    'input',
    () => t('请求用户输入'),
    async (ctx, _args, text) => (await ctx.prompt(text)) ?? '',
    () => t('提示文字'),
  )
  plain(
    'model',
    () => t('显示当前模型'),
    async (ctx) => (await ctx.api.getChatProfile(requireChat(ctx))).model,
  )
}
