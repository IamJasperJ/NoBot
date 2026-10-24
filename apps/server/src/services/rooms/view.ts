import { playPresetDataSchema } from '@nobot/shared'
import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { backgrounds } from '../../db/schema'
import { getBackgroundSettings, listBackgrounds } from '../backgrounds/backgrounds'
import { getChatRow, loadGroupDTO, loadPath } from '../chats'
import { computeStage, resolvePlayPreset } from '../generation/stage'
import { charactersForRoom, type Room } from './index'

/** 只输出渲染需要的玩法选项，移除提示词、模型选择和状态注入配置。 */
export function stageViewPlay(chatId: string) {
  const source = resolvePlayPreset(chatId).data
  return playPresetDataSchema.parse({
    basic: source.basic,
    stage: source.stage,
    dialog: source.dialog,
    interaction: source.interaction,
    audio: source.audio,
    trpg: source.trpg,
    directives: {
      enabled: source.directives.enabled,
      style: source.directives.style,
      kinds: source.directives.kinds,
      showSpeaker: source.directives.showSpeaker,
    },
    sprites: {
      fallback: source.sprites.fallback,
      avatarFallback: source.sprites.avatarFallback,
      randomMultiple: source.sprites.randomMultiple,
      rerollSame: source.sprites.rerollSame,
      customExpressions: source.sprites.customExpressions,
      sideSprite: source.sprites.sideSprite,
    },
    state: { inline: source.state.inline, mvu: source.state.mvu },
  })
}

export function roomView(room: Room) {
  const chat = getChatRow(room.chatId)
  const play = stageViewPlay(room.chatId)
  const globalBackgroundId = getBackgroundSettings().globalId
  const refs = new Set([
    chat.backgroundId,
    globalBackgroundId,
    ...charactersForRoom(room).map((c) => c.defaultBackgroundId),
    chat.groupId ? loadGroupDTO(chat.groupId).defaultBackgroundId : null,
    computeStage(room.chatId, loadPath(chat.activeLeafId))?.scene.backgroundId,
    ...db
      .select()
      .from(backgrounds)
      .where(eq(backgrounds.chatId, room.chatId))
      .all()
      .map((b) => b.id),
  ])
  return {
    play,
    globalBackgroundId,
    backgrounds: listBackgrounds()
      .filter((b) => refs.has(b.id))
      .map((b) => ({ ...b, description: '', folderIds: [] })),
  }
}
