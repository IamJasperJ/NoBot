import type { AttachmentDTO } from '@nobot/shared'

/** 自动判定只匹配已知视觉型号；手动设置优先于模型名。 */
export function supportsVision(model: string, vision: 'auto' | 'yes' | 'no' = 'auto'): boolean {
  if (vision !== 'auto') return vision === 'yes'
  return /gpt-(?:4o|4\.1|5)(?:\b|[-.])|claude-(?:[3-9]|(?:sonnet|opus|haiku)-[4-9])|gemini|qwen[^/]*[-_]vl|llava|pixtral|glm-[4-9][^\s/]*v/i.test(
    model,
  )
}

/** 文字回退保留每张图片的顺序，缺少说明也保留占位。 */
export function imageDescriptions(images: Pick<AttachmentDTO, 'caption'>[]): string {
  return images.map((image) => (image.caption?.trim() ? `[Image: ${image.caption.trim()}]` : '[Image]')).join('\n')
}
