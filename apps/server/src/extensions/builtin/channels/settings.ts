import { type ChannelSettingsOverride, type ChannelSettingsResolution, channelSettingsSchema } from '@nobot/shared'

/** 显式 false、0 不视为空值；按每个键提供来源，便于界面展示继承关系。 */
export function resolveChannelSettings(
  account: { settings?: ChannelSettingsOverride },
  binding?: { settings?: ChannelSettingsOverride },
  global: ChannelSettingsOverride = {},
): ChannelSettingsResolution {
  const values = channelSettingsSchema.parse(global)
  const provenance = {} as ChannelSettingsResolution['provenance']
  for (const key of Object.keys(values) as (keyof typeof values)[]) {
    provenance[key] =
      binding?.settings?.[key] !== undefined ? 'binding' : account.settings?.[key] !== undefined ? 'account' : 'global'
  }
  const defined = (settings: ChannelSettingsOverride = {}) =>
    Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined))
  return {
    values: channelSettingsSchema.parse({ ...values, ...defined(account.settings), ...defined(binding?.settings) }),
    provenance,
  }
}

/** 使用结构化键避免平台 id、话题 id 中的分隔符碰撞。 */
export function locationKey(
  ref: { scope: string; chat: string; thread?: string; actor?: string },
  isolation: 'dm' | 'shared' | 'per-user' | 'per-topic',
) {
  return JSON.stringify([
    ref.scope,
    ref.chat,
    isolation === 'per-topic' ? (ref.thread ?? '') : '',
    isolation === 'per-user' ? (ref.actor ?? '') : '',
  ])
}

/** 明确的话题、个人绑定优先，不能被较早创建的群共享绑定遮住。 */
export function matchChannelBinding<
  T extends Parameters<typeof locationKey>[0] & { isolation: Parameters<typeof locationKey>[1] },
>(bindings: T[], ref: Parameters<typeof locationKey>[0]): T | undefined {
  const specificity = (binding: T) =>
    binding.isolation === 'per-topic' && binding.thread
      ? 3
      : binding.isolation === 'per-user'
        ? 2
        : binding.isolation === 'dm'
          ? 1
          : 0
  return bindings
    .filter((binding) => locationKey(binding, binding.isolation) === locationKey(ref, binding.isolation))
    .sort((a, b) => specificity(b) - specificity(a))[0]
}
