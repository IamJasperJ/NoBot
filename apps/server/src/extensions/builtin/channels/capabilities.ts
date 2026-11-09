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

/** 只学习这些扩展动作；标准动作的失败不能改变协议能力。 */
export const oneBotExtensionActions = {
  avatar: ['set_qq_avatar'],
  name: ['set_qq_profile'],
  description: ['set_self_longnick'],
  onlineStatus: ['set_online_status'],
  reactions: ['set_msg_emoji_like'],
  poke: ['group_poke', 'friend_poke'],
  dailySign: ['set_group_sign'],
  essence: ['set_essence_msg'],
  notice: ['_send_group_notice'],
  markRead: ['mark_msg_as_read'],
  forward: ['send_group_forward_msg'],
  deleteFriend: ['delete_friend'],
  fetchCustomFace: ['fetch_custom_face'],
} as const

/** 连接过的实现默认允许扩展，仅根据真实调用的 1404 收窄能力。 */
export function implementationCapabilities(name: string, unsupported: readonly string[] = []): ChannelCapabilities {
  const capabilities: ChannelCapabilities = {
    ...providerCapabilities.onebot11,
    tempSessionDm: name ? 'supported' : 'unknown',
    shortDescription: 'unsupported',
    topic: 'unsupported',
    draftStreaming: 'unsupported',
    menuButton: 'unsupported',
    managedBots: 'unsupported',
    oneTimeStageLink: 'supported',
  }
  for (const [key, actions] of Object.entries(oneBotExtensionActions)) {
    if (key === 'fetchCustomFace') continue
    capabilities[key as keyof ChannelCapabilities] = !name
      ? 'unknown'
      : actions.every((action) => unsupported.includes(action))
        ? 'unsupported'
        : key === 'essence' || key === 'notice'
          ? 'permission_required'
          : 'supported'
  }
  return capabilities
}
