import type { ChannelCapabilities, ChannelProvider } from '@nobot/shared'

/** 注册表描述接口能力，实际写操作仍要检查当前群权限。 */
export const providerCapabilities: Record<ChannelProvider, ChannelCapabilities> = {
  telegram: {
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
    avatar: 'supported',
    name: 'supported',
    description: 'supported',
    shortDescription: 'unknown',
    onlineStatus: 'supported',
    groupCard: 'supported',
    friendRequest: 'supported',
    leaveGroup: 'supported',
    reactions: 'supported',
    pin: 'permission_required',
    topic: 'unknown',
  },
}
