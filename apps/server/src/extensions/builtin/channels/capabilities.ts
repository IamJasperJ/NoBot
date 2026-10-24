import type { ChannelCapabilities, ChannelProvider } from '@nobot/shared'

/** 注册表描述接口能力，实际写操作仍要检查当前群权限。 */
export const providerCapabilities: Record<ChannelProvider, ChannelCapabilities> = {
  telegram: {
    draftStreaming: 'supported',
    menuButton: 'supported',
    managedBots: 'supported',
    oneTimeStageLink: 'unsupported',
    poke: 'unsupported',
    dailySign: 'unsupported',
    essence: 'unsupported',
    notice: 'unsupported',
    markRead: 'unsupported',
    tempSessionDm: 'unsupported',
    friends: 'unsupported',
    deleteFriend: 'unsupported',
    avatar: 'supported',
    name: 'supported',
    description: 'supported',
    shortDescription: 'supported',
    onlineStatus: 'unsupported',
    groupCard: 'unsupported',
    friendRequest: 'unsupported',
    leaveGroup: 'supported',
    reactions: 'supported',
    pin: 'permission_required',
    topic: 'permission_required',
    chatTitle: 'permission_required',
    chatDescription: 'permission_required',
  },
  onebot11: {
    avatar: 'unknown',
    name: 'unknown',
    description: 'unknown',
    shortDescription: 'unsupported',
    onlineStatus: 'unknown',
    groupCard: 'supported',
    friendRequest: 'supported',
    groupInvite: 'supported',
    joinRequests: 'supported',
    friends: 'supported',
    leaveGroup: 'supported',
    reactions: 'unknown',
    pin: 'unsupported',
    topic: 'unsupported',
  },
}

/** 未知实现只声明 OneBot 标准能力，扩展接口不能凭兼容协议推断。 */
export function implementationCapabilities(name: string): ChannelCapabilities {
  const napcat = /napcat/i.test(name)
  return {
    ...providerCapabilities.onebot11,
    ...Object.fromEntries(
      [
        'avatar',
        'name',
        'description',
        'onlineStatus',
        'reactions',
        'poke',
        'dailySign',
        'essence',
        'notice',
        'markRead',
        'forward',
        'tempSessionDm',
        'deleteFriend',
      ].map((key) => [key, napcat ? 'supported' : 'unknown']),
    ),
    essence: napcat ? 'permission_required' : 'unknown',
    notice: napcat ? 'permission_required' : 'unknown',
    shortDescription: 'unsupported',
    topic: 'unsupported',
    draftStreaming: 'unsupported',
    menuButton: 'unsupported',
    managedBots: 'unsupported',
    oneTimeStageLink: 'supported',
  }
}
