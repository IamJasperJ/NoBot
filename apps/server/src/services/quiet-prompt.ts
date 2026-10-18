import { HttpError } from '../errors'
import type { ExtensionHost } from '../extensions/types'
import { t } from '../i18n'
import { buildRequestBody, chatCompletion } from '../llm/openai'
import { redactImages, resolveImages } from './attachments'
import { replaceImageAttachments } from './caption'
import { getApiPresetRow } from './connections'
import { assembleWithVectors, loadGenerationContext } from './context'
import { insertLog } from './logs'

/** 与扩展宿主共用静默生成，保持上下文、图片处理和日志行为一致。 */
export function quietPrompt(opts: Parameters<ExtensionHost['quietPrompt']>[0]): Promise<string> {
  return requestCompletion(opts)
}

/** 直接请求与静默组装共用连接、采样参数、响应清理及日志。 */
export function complete(opts: Parameters<ExtensionHost['complete']>[0]): Promise<string> {
  return requestCompletion(opts)
}

async function requestCompletion(
  opts: Parameters<ExtensionHost['quietPrompt']>[0] | Parameters<ExtensionHost['complete']>[0],
): Promise<string> {
  const summary = 'messages' in opts ? opts.summary : opts.instruction.slice(0, 60)
  const avatar = 'avatar' in opts ? opts.avatar : undefined
  const started = Date.now()
  let model: string | null = null
  let request: unknown
  try {
    const ctx = loadGenerationContext(opts.chatId, { requireConnection: !opts.connectionId })
    const connection = opts.connectionId ? getApiPresetRow(opts.connectionId) : ctx.connection
    if (!connection) throw new HttpError(400, 'NO_CONNECTION', t('没有可用的模型连接'))
    model = opts.model || connection.model
    let prompt =
      'messages' in opts
        ? [...opts.messages]
        : (
            await assembleWithVectors(ctx, {
              type: 'normal',
              speakerId: opts.speakerId ?? ctx.members[0]?.id ?? '',
              leafId: opts.includeHistory === false ? null : ctx.chat.activeLeafId,
              toolsEnabled: false,
              quiet: true,
            })
          ).messages
    if ('instruction' in opts) prompt.push({ role: instructionRole(prompt, opts.role), content: opts.instruction })
    prompt = replaceImageAttachments(prompt, { ...connection, model })
    const images = await resolveImages(prompt, ctx.preset.samplers.imageMaxSize)
    const body = buildRequestBody({
      model,
      messages: prompt,
      images,
      samplers: {
        ...ctx.preset.samplers,
        stream: false,
        ...(opts.maxTokens === undefined ? {} : { maxTokens: opts.maxTokens }),
      },
    })
    if (avatar) {
      // 头像仅用于本次外貌提炼，不保存为聊天附件，日志也不写入图片数据。
      const sharp = (await import('sharp')).default
      const png = await sharp(avatar).png().toBuffer()
      const messages = body.messages as Record<string, unknown>[]
      messages[messages.length - 1] = {
        role: 'user',
        content: [
          { type: 'text', text: 'instruction' in opts ? opts.instruction : '' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
        ],
      }
    }
    // 额外请求参数也不能让静默请求变成工具调用或覆盖调用方的输出上限。
    body.stream = false
    delete body.stream_options
    delete body.tools
    delete body.tool_choice
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens
    request = avatar
      ? { ...redactImages(body, images), messages: t('[头像外貌提炼，图片数据已隐藏]') }
      : redactImages(body, images)
    let text = ''
    for await (const chunk of chatCompletion({
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      headers: connection.headers,
      body,
      signal: opts.signal ?? new AbortController().signal,
    }))
      text += chunk.text ?? ''
    text = text.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '').trim()
    insertLog({
      chatId: opts.chatId,
      kind: 'extension',
      status: 'ok',
      model,
      durationMs: Date.now() - started,
      summary,
      request,
      response: { content: text },
    })
    return text
  } catch (error) {
    insertLog({
      chatId: opts.chatId,
      kind: 'extension',
      status: 'error',
      model,
      durationMs: Date.now() - started,
      summary,
      request,
      response: { error: error instanceof Error ? error.message : String(error) },
    })
    throw error
  }
}

/** 无对话内容时必须提供 user 消息，兼容要求 contents 的接口。 */
export function instructionRole(prompt: { role: string }[], role?: 'system' | 'user' | 'assistant') {
  return role ?? (prompt.some((message) => message.role === 'user' || message.role === 'assistant') ? 'system' : 'user')
}
