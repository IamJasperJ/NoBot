import { imageDescriptions, supportsVision } from '@ai-parter/core'
import { getSetting } from '../db/client'
import type { ApiPresetRow } from '../db/schema'
import { getAttachment } from './attachments'
import { SETTING_KEYS } from './settings'

/** 能力回退不依赖扩展启用；强制文字描述只在扩展开启时生效。 */
export function replaceImageAttachments<T extends { content: string; images?: string[] }>(
  history: T[],
  connection: ApiPresetRow | null,
): T[] {
  const enabled = getSetting<Record<string, boolean>>(SETTING_KEYS.extensionsEnabled)?.caption === true
  const settings = getSetting<Record<string, unknown>>(SETTING_KEYS.extensionSettings('caption'))
  if (connection && supportsVision(connection.model, connection.vision) && !(enabled && settings?.alwaysText === true))
    return history
  return history.map((message) => {
    if (!message.images?.length) return message
    const { images, ...rest } = message
    return {
      ...rest,
      content: [
        message.content,
        imageDescriptions(
          images.map((id) => {
            try {
              return getAttachment(id)
            } catch {
              return {}
            }
          }),
        ),
      ]
        .filter(Boolean)
        .join('\n'),
    } as T
  })
}
