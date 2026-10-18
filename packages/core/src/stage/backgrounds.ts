/** 保留既有舞台优先级：固定会话背景 > 舞台背景 > 未固定会话背景 > 所属角色或群组默认背景 > 全局背景。 */
export function resolveBackgroundId(input: {
  backgroundId?: string | null
  backgroundPinned?: boolean
  stageBackgroundId?: string | null
  defaultBackgroundId?: string | null
  globalId?: string | null
}): string | null {
  if (input.backgroundPinned && input.backgroundId) return input.backgroundId
  return input.stageBackgroundId ?? input.backgroundId ?? input.defaultBackgroundId ?? input.globalId ?? null
}
