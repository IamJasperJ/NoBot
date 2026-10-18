import type { ChatMessage, SamplerSettings } from '@ai-parter/shared'
import { t } from '../i18n'
import { LlmError } from './types'
/**
 * 根据生成预设的采样参数生成请求体。
 * 非 OpenAI 标准的参数（top_k、min_p、top_a、repetition_penalty）只在不是默认值时才发送，
 * 因为 OpenAI 官方等接口遇到不认识的参数会直接报错。
 */
export function buildRequestBody(opts: {
  model: string
  messages: ChatMessage[]
  samplers: SamplerSettings
  images?: Map<string, string>
  tools?: unknown[]
}): Record<string, unknown> {
  const s = opts.samplers
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages.map(({ images, ...message }) => {
      if (!images?.length) return message
      return {
        ...message,
        content: [
          { type: 'text', text: message.content },
          ...images.map((id) => {
            const url = opts.images?.get(id)
            if (!url) throw new LlmError('BAD_ATTACHMENT', t('图片附件尚未解析'))
            return { type: 'image_url', image_url: { url, detail: s.imageDetail } }
          }),
        ],
      }
    }),
    stream: s.stream,
    max_tokens: s.maxTokens,
    temperature: s.temperature,
    top_p: s.topP,
    frequency_penalty: s.frequencyPenalty,
    presence_penalty: s.presencePenalty,
  }
  if (s.stream) body.stream_options = { include_usage: true }
  if (s.topK > 0) body.top_k = s.topK
  if (s.minP > 0) body.min_p = s.minP
  if (s.topA > 0) body.top_a = s.topA
  if (s.repetitionPenalty !== 1) body.repetition_penalty = s.repetitionPenalty
  if (s.seed >= 0) body.seed = s.seed
  if (s.stop.length > 0) body.stop = s.stop.slice(0, 4) // OpenAI 最多 4 个
  if (s.reasoningEffort !== 'auto') body.reasoning_effort = s.reasoningEffort
  if (s.requestReasoning) body.include_reasoning = true
  if (opts.tools && opts.tools.length > 0) body.tools = opts.tools

  // 额外参数：用户写的 JSON 原样合并，可以覆盖上面的任何字段
  if (s.extraBody.trim()) {
    try {
      const extra = JSON.parse(s.extraBody)
      if (extra && typeof extra === 'object' && !Array.isArray(extra)) Object.assign(body, extra)
    } catch {
      throw new LlmError('BAD_EXTRA_BODY', t('生成预设里的「额外请求参数」不是合法的 JSON 对象'))
    }
  }
  return body
}
