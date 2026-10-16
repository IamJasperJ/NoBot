import type { CastMember, StageOp, StagePosition, StageState } from '@ai-parter/shared'

export function castKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s/g, '')
}

export function autoPosition(cast: CastMember[]): StagePosition {
  if (!cast.length) return 'center'
  const occupied = new Set(cast.map((member) => member.at))
  const positions: StagePosition[] = ['left', 'right', 'center', 1, 2, 3, 4, 5]
  return positions.find((position) => !occupied.has(position)) ?? 'center'
}

export function applyStageOps(state: StageState, ops: StageOp[]): StageState {
  const next: StageState = { scene: { ...state.scene }, cast: state.cast.map((member) => ({ ...member })) }
  for (const op of ops) {
    if (op.op === 'scene') {
      if (op.bg !== undefined && op.bg !== next.scene.bg) delete next.scene.backgroundId
      for (const field of ['bg', 'bgm', 'place', 'time'] as const) {
        if (op[field] !== undefined) next.scene[field] = op[field]
      }
      continue
    }
    const key = castKey(op.who)
    const index = next.cast.findIndex((member) => castKey(member.name) === key)
    if (op.op === 'hide') {
      if (index >= 0) next.cast.splice(index, 1)
      continue
    }
    let member = next.cast[index]
    if (!member) {
      member = { key, name: op.who, expression: '', at: autoPosition(next.cast) }
      next.cast.push(member)
    }
    member.name = op.who
    if (op.expression !== undefined) member.expression = op.expression
    if (op.op === 'show') {
      if (op.at !== undefined) member.at = op.at
      if (op.outfit !== undefined) member.outfit = op.outfit
    }
  }
  return next
}
