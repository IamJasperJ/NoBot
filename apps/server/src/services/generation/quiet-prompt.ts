import { IMAGE_TOKENS, promptMessageTokens, promptTokenBudget } from '@nobot/core'
import { type ChatMessage, providerInfo, type SamplerSettings } from '@nobot/shared'
import { HttpError } from '../../errors'
import type { ExtensionHost } from '../../extensions/types'
import { t } from '../../i18n'
import { parseExtraBody } from '../../llm/body'
import { buildRequestBody, chatCompletion, toLlmConnection } from '../../llm/openai'
import { redactImages, resolveImages } from '../attachments'
import { replaceImageAttachments } from '../caption'
import { getApiPresetRow } from '../connections'
import { insertLog } from '../logs'
import { resolveProfile } from '../profiles'
import { assembleWithVectors, loadGenerationContext, loadLore } from './context'

/** 与扩展宿主共用静默生成，保持上下文、图片处理和日志行为一致。 */
export function quietPrompt(opts: Parameters<ExtensionHost['quietPrompt']>[0]): Promise<string> {
  return requestCompletion(opts)
}

/** 直接请求与静默组装共用连接、采样参数、响应清理及日志。 */
export function complete(opts: Parameters<ExtensionHost['complete']>[0]): Promise<string> {
  return requestCompletion(opts)
}

export function completionLimits(base: SamplerSettings, provider: string, requested?: number) {
  const extra = parseExtraBody(base.extraBody)
  const protocol = providerInfo(provider).protocol
  const useCompletionLimit = (protocol === 'openai' || protocol === 'azure') && extra.max_completion_tokens != null
  const maxTokens = requested ?? (useCompletionLimit ? extra.max_completion_tokens : extra.max_tokens) ?? base.maxTokens
  if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens < 1)
    throw new HttpError(400, 'BAD_REQUEST', t('模型回复上限必须是正整数'))
  const reasoning = extra.reasoning_effort ?? base.reasoningEffort
  // Claude 的传统思考模式会在请求转换时抬高回复上限。
  const reservedOutput =
    protocol === 'anthropic' && reasoning && reasoning !== 'auto' ? Math.max(2048, maxTokens) : maxTokens
  const budget = promptTokenBudget(base.contextSize, reservedOutput)
  return { extra, useCompletionLimit, maxTokens, reservedOutput, budget }
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
    opts.signal?.throwIfAborted()
    const ctx =
      'instruction' in opts || opts.chatId
        ? loadGenerationContext(opts.chatId!, { requireConnection: !opts.connectionId })
        : null
    const profile = ctx ?? resolveProfile(undefined, !opts.connectionId)
    if (ctx && 'purpose' in opts && opts.purpose === 'image') {
      // 酒馆按当前主体加载角色世界书；其他群成员的常驻条目不能抢占本次人物的身份资料。
      ctx.loreEntries = loadLore(opts.chatId, [opts.speakerId ?? ctx.members[0]?.id ?? ''], ctx.persona.lorebookId)
    }
    const connection = opts.connectionId ? getApiPresetRow(opts.connectionId) : profile.connection
    if (!connection) throw new HttpError(400, 'NO_CONNECTION', t('没有可用的模型连接'))
    model = opts.model || connection.model
    const resolvedConnection = { ...connection, model }
    const base = profile.preset.samplers
    const { extra, useCompletionLimit, maxTokens, reservedOutput, budget } = completionLimits(
      base,
      connection.provider,
      opts.maxTokens,
    )
    const samplers = { ...base, stream: false, maxTokens, extraBody: '' }
    const avatarTokens = avatar ? IMAGE_TOKENS : 0
    let prompt: ChatMessage[]
    if ('messages' in opts) {
      prompt = [...opts.messages]
    } else {
      const assembled = await assembleWithVectors(
        {
          ...ctx!,
          connection: resolvedConnection,
          preset: { ...profile.preset, samplers: { ...samplers, maxTokens: reservedOutput } },
        },
        {
          type: 'normal',
          speakerId: opts.speakerId ?? ctx!.members[0]?.id ?? '',
          leafId:
            opts.includeHistory === false ? null : opts.leafId === undefined ? ctx!.chat.activeLeafId : opts.leafId,
          toolsEnabled: false,
          quiet: true,
          plainHistory: opts.purpose === 'image',
          reservedTokens: promptMessageTokens({ content: opts.instruction }) + avatarTokens,
        },
        opts.signal,
      )
      if (opts.requiredHistoryIds?.length) {
        const history = new Set(
          assembled.report.segments.flatMap((segment) =>
            segment.source === 'history' && segment.messageId ? [segment.messageId] : [],
          ),
        )
        if (opts.requiredHistoryIds.some((id) => !history.has(id)))
          throw new HttpError(400, 'PROMPT_HISTORY_OMITTED', t('请求缺少所需的历史消息，请检查预设或增大上下文预算'))
      }
      prompt = assembled.messages
      if (opts.purpose === 'image') prompt = textOnlyHistory(prompt)
      const role = instructionRole(prompt, opts.role)
      // 酒馆会把末尾静默指令与相邻的同角色消息合并，再交给模型，避免额外系统消息改变后处理语义。
      const tail = prompt.at(-1)
      if (opts.purpose === 'image' && !avatar && tail?.role === role) tail.content += `\n\n${opts.instruction}`
      else prompt.push({ role, content: opts.instruction })
    }
    prompt = replaceImageAttachments(prompt, resolvedConnection)
    const inputTokens = prompt.reduce((total, message) => total + promptMessageTokens(message), avatarTokens)
    if (inputTokens > budget || reservedOutput >= base.contextSize)
      throw new HttpError(400, 'PROMPT_TOO_LONG', t('静默请求超出上下文预算，请缩短输入或调整生成预设'))
    const images = await resolveImages(prompt, samplers.imageMaxSize)
    const body = buildRequestBody({
      model,
      messages: prompt,
      images,
      samplers,
    })
    // 静默任务的模型与消息由调用方和实际组装确定，额外参数只补充其余配置。
    const {
      model: _model,
      messages: _messages,
      max_tokens: _limit,
      max_completion_tokens: _completionLimit,
      ...additional
    } = extra
    Object.assign(body, additional)
    if (useCompletionLimit) {
      delete body.max_tokens
      body.max_completion_tokens = maxTokens
    }
    if (avatar) {
      // 头像仅用于本次外貌提炼，不保存为聊天附件，日志也不写入图片数据。
      const sharp = (await import('sharp')).default
      const png = await sharp(avatar).png().toBuffer()
      const messages = body.messages as Record<string, unknown>[]
      messages[messages.length - 1] = {
        role: 'user',
        content: [
          { type: 'text', text: 'instruction' in opts ? opts.instruction : (opts.messages.at(-1)?.content ?? '') },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
        ],
      }
    }
    // 额外请求参数也不能让静默请求变成工具调用或覆盖调用方的输出上限。
    body.stream = false
    delete body.stream_options
    delete body.tools
    delete body.tool_choice
    delete body.functions
    delete body.function_call
    delete body.parallel_tool_calls
    if ('purpose' in opts && opts.purpose === 'image') body.tool_choice = 'none'
    request = avatar
      ? { ...redactImages(body, images), messages: t('[头像外貌提炼，图片数据已隐藏]') }
      : redactImages(body, images)
    opts.signal?.throwIfAborted()
    let text = ''
    for await (const chunk of chatCompletion({
      connection: toLlmConnection(connection),
      body,
      signal: opts.signal ?? new AbortController().signal,
    }))
      text += chunk.text ?? ''
    opts.signal?.throwIfAborted()
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
      status: opts.signal?.aborted ? 'aborted' : 'error',
      model,
      durationMs: Date.now() - started,
      summary,
      request,
      response: { error: error instanceof Error ? error.message : String(error) },
    })
    throw error
  }
}

/** 静默图片提炼只能阅读工具历史；将调用与结果转成文字，不能再次执行历史工具。 */
export function textOnlyHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(({ tool_calls, tool_call_id: _callId, ...message }) => {
    const history = (tool_calls ?? []).map(
      (call) => `[Previous tool call: ${call.function.name}] ${call.function.arguments}`,
    )
    if (message.role === 'tool') {
      message.role = 'user'
      delete message.name
      history.unshift('[Previous tool result]')
    }
    return { ...message, content: [message.content, ...history].filter(Boolean).join('\n') }
  })
}

/** 无对话内容时必须提供 user 消息，兼容要求 contents 的接口。 */
export function instructionRole(prompt: { role: string }[], role?: 'system' | 'user' | 'assistant') {
  return role ?? (prompt.some((message) => message.role === 'user' || message.role === 'assistant') ? 'system' : 'user')
}
