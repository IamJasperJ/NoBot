import { t } from '../../../../../i18n'
import { requestLanguage } from '../../../../../i18n/request-language'
import type { TelegramClient } from './client'

/** 中文键集中存放，菜单和 /help 共用命令集合；仅用平台 scope 限制可见性，执行仍走房间权限。 */
const commandKeys = {
  vn: '打开 VN',
  new: '新开会话',
  chats: '切换历史会话',
  char: '切换角色',
  group: '切换角色群组',
  stop: '停止生成',
  regen: '重新生成',
  continue: '继续生成',
  swipe: '切换候选回复',
  persona: '设置房间人设',
  ooc: '发送场外消息',
  roll: '掷骰',
  whisper: '发送私信',
  ready: '本轮完成',
  pass: '跳过本轮',
  invite: '授权平台成员',
  kick: '移除房间成员',
  help: '查看命令帮助',
} as const
export async function syncCommands(client: TelegramClient, signal: AbortSignal) {
  for (const language of ['zh', 'en'] as const) {
    const commands = await requestLanguage.run(language, async () => {
      // t() 在用户上下文中遵循用户语言；菜单英文显式取词典，不能改全局用户设置。
      const { en } = await import('../../../../../i18n/en')
      return Object.entries(commandKeys).map(([command, key]) => ({
        command,
        description: language === 'en' ? (en[key] ?? key) : key,
      }))
    })
    for (const scope of ['all_private_chats', 'all_group_chats', 'all_chat_administrators']) {
      const visible =
        scope === 'all_group_chats' ? commands.filter((c) => !['invite', 'kick'].includes(c.command)) : commands
      await client.call('setMyCommands', { commands: visible, scope: { type: scope }, language_code: language }, signal)
    }
  }
}
/** 静态键用显式调用，让双语检查覆盖每项菜单。 */
export function translatedCommandDescription(command: keyof typeof commandKeys) {
  switch (command) {
    case 'vn':
      return t('打开 VN')
    case 'new':
      return t('新开会话')
    case 'chats':
      return t('切换历史会话')
    case 'char':
      return t('切换角色')
    case 'group':
      return t('切换角色群组')
    case 'stop':
      return t('停止生成')
    case 'regen':
      return t('重新生成')
    case 'continue':
      return t('继续生成')
    case 'swipe':
      return t('切换候选回复')
    case 'persona':
      return t('设置房间人设')
    case 'ooc':
      return t('发送场外消息')
    case 'roll':
      return t('掷骰')
    case 'whisper':
      return t('发送私信')
    case 'ready':
      return t('本轮完成')
    case 'pass':
      return t('跳过本轮')
    case 'invite':
      return t('授权平台成员')
    case 'kick':
      return t('移除房间成员')
    case 'help':
      return t('查看命令帮助')
  }
}
