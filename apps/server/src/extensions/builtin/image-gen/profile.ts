import type { ProfileImage } from '@nobot/shared'
import { t } from '../../../i18n'
import type { Settings } from './settings'

/** 把配置组的图片覆盖合并进扩展设置；image 为空时只处理提示词连接。 */
export function applyProfileImage(
  settings: Settings,
  profile: { image: ProfileImage | null; promptConnectionId: string | null } | null,
): Settings {
  const result = { ...settings }
  result.promptConnectionId ||= profile?.promptConnectionId ?? ''
  const image = profile?.image
  if (!image) return result
  result.source = image.source
  switch (image.source) {
    case 'openai':
      if (image.connectionId) result.openaiConnectionId = image.connectionId
      if (image.model) result.openaiModel = image.model
      break
    case 'openrouter':
      if (image.connectionId) result.openrouterConnectionId = image.connectionId
      if (image.model) result.openrouterModel = image.model
      break
    case 'comfy':
      if (image.url) result.comfyUrl = image.url
      if (image.headers.trim()) result.comfyHeaders = image.headers
      if (image.model) result.comfyCheckpoint = image.model
      if (image.comfyWorkflow !== null) result.comfyWorkflowName = image.comfyWorkflow
      break
    case 'a1111':
      if (image.url) result.a1111Url = image.url
      if (image.model) result.a1111Model = image.model
      break
  }
  if (image.style) {
    if (settings.styles.some((style) => style.name === image.style)) result.activeStyle = image.style
    else console.warn(t('配置组指定的图片风格不存在：{style}', { style: image.style }))
  }
  return result
}
