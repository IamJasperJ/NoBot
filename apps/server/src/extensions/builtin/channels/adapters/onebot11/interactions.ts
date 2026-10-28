import type { ChannelSettings } from '@nobot/shared'
import { getSetting, setSetting } from '../../../../../db/client'

/** 预算先扣再调用，重启或平台失败不能绕过每日限制。 */
export function socialBudget(account: string, target: string, settings: ChannelSettings, now = Date.now()) {
  const key = `channels:onebot-social:${account}`
  const day = Math.floor(now / 86400000)
  const saved = getSetting<{ day: number; count: number; last: Record<string, number> }>(key)
  const state = saved?.day === day ? saved : { day, count: 0, last: {} }
  if (
    (settings.socialDailyBudget > 0 && state.count >= settings.socialDailyBudget) ||
    now - (state.last[target] ?? -Infinity) < settings.socialCooldownMs
  )
    return false
  state.count++
  state.last[target] = now
  setSetting(key, state)
  return true
}
export function signBudget(account: string, group: string, now = Date.now()) {
  const key = `channels:onebot-sign:${account}:${group}`
  const day = Math.floor(now / 86400000)
  if (getSetting<number>(key) === day) return false
  setSetting(key, day)
  return true
}
