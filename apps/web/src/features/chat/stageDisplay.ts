import type { MessageDTO } from '@nobot/shared'
import type { ChatCast } from './MessageItem'

/**
 * 这条消息按什么舞台规则显示（null 表示原样显示）。
 * - 当前玩法预设开了舞台指令：所有角色回复都按当前规则
 * - 没开，但这条回复是开着指令时生成的（带 meta.stage）：仍隐藏标签、台词改写，保持生成时的样子；
 *   不显示可点的选项（指令关了，选了也不会按选项推进）
 */
export function stageDisplayFor(cast: ChatCast, msg: Pick<MessageDTO, 'role' | 'meta'>): ChatCast['stage'] {
  if (msg.role !== 'assistant') return null
  if (cast.stage) return cast.stage
  const stage = msg.meta.stage
  if (!stage || !cast.pastStage) return null
  // 当时的出场角色可能已经不在会话里了：用这条消息自己记下的说话人补上
  const speakers = stage.beats.flatMap((beat) => (beat.kind === 'line' ? [beat.speaker] : []))
  return { ...cast.pastStage, knownNames: [...new Set([...cast.pastStage.knownNames, ...speakers])], choices: false }
}
