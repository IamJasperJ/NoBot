import type { CastMember, StageOp, StagePosition, StageState } from '@nobot/shared'

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
  if (state.combat) next.combat = { ...state.combat, order: state.combat.order.map((actor) => ({ ...actor })) }
  for (const op of ops) {
    if (op.op === 'combat') {
      if (op.action === 'start') {
        const order = op.order ?? op.who.map((name) => ({ key: castKey(name), name, initiative: 0 }))
        next.combat = {
          round: 1,
          turn: 0,
          order: order.map((actor) => ({ ...actor })).sort((a, b) => b.initiative - a.initiative),
        }
      } else if (next.combat) {
        if (op.action === 'end') delete next.combat
        else if (next.combat.order.length) {
          next.combat.turn++
          if (next.combat.turn >= next.combat.order.length) {
            next.combat.turn = 0
            next.combat.round++
          }
        }
      }
      continue
    }
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

/** 已有先攻的操作保持幂等，避免回放时重掷；排序交给舞台折叠处理。 */
export function resolveCombatStart<T extends StageOp>(op: T, roll: (name: string) => number): T {
  if (op.op !== 'combat' || op.action !== 'start' || op.order !== undefined) return op
  return { ...op, order: op.who.map((name) => ({ key: castKey(name), name, initiative: roll(name) })) }
}
