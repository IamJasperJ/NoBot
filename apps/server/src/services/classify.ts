import { castKey, DEFAULT_CLASSIFY_PROMPT, extractExpressionLabel, toDisplayText } from '@ai-parter/core/stage'
import { EXPRESSIONS } from '@ai-parter/shared'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { characters, messages, sprites } from '../db/schema'
import { t } from '../i18n'
import { buildRequestBody, chatCompletion, toLlmConnection } from '../llm/openai'
import { getChatRow, loadPath } from './chats'
import { getApiPresetRow } from './connections'
import { loadGenerationContext } from './context'
import { insertLog, logError } from './logs'
import { resolveProfile } from './profiles'
import { quietPrompt } from './quiet-prompt'
import { computeStage, resolvePlayPreset } from './stage'

/** 仅由生成收尾调用；先同步写 pending，再启动后台请求。 */
export function classifyMessage(messageId: string): void {
  const message = db.select().from(messages).where(eq(messages.id, messageId)).get()
  if (message?.role !== 'assistant' || message.status !== 'done' || !message.speakerId || !message.meta.stage) return
  const preset = resolvePlayPreset(message.chatId).data
  const options = preset.sprites
  if (!preset.directives.enabled || options.classify === 'off') return
  const speaker = db.select().from(characters).where(eq(characters.id, message.speakerId)).get()
  if (!speaker) return
  const names = [speaker.name, speaker.name.trim().split(/\s+/)[0]!].map(castKey)
  if (
    options.classify === 'missing' &&
    message.meta.stage.ops.some((op) => op.op === 'expr' && names.includes(castKey(op.who)))
  )
    return
  const meta = { ...message.meta, stage: { ...message.meta.stage, classify: 'pending' as const } }
  db.update(messages).set({ meta }).where(eq(messages.id, messageId)).run()
  // 结果里的演员名沿用这条消息对说话人的写法（比如台上叫 Ellie，角色卡叫 Ellie Sunleaf），
  // 否则 expr 操作会让同一个人以另一个名字再上一次台
  const stage = message.meta.stage
  const written = [
    ...stage.ops.flatMap((op) => (op.op === 'scene' ? [] : [op.who])),
    ...stage.beats.flatMap((beat) => (beat.kind === 'line' ? [beat.speaker] : [])),
  ]
  // 再看台上：已经有对应到这个角色卡的演员（比如开场白写的 Ellie），就沿用他的名字
  const onStage = computeStage(message.chatId, loadPath(message.id))?.cast.find((m) => m.characterId === speaker.id)
  const who = written.find((name) => names.includes(castKey(name))) ?? onStage?.name ?? speaker.name
  const labels = [
    ...new Set(
      db
        .select({ expression: sprites.expression })
        .from(sprites)
        .where(eq(sprites.characterId, speaker.id))
        .all()
        .map((row) => row.expression),
    ),
  ].sort()
  if (!labels.length) labels.push(...new Set([...EXPRESSIONS, ...options.customExpressions]))
  const prompt = (options.classifyPrompt || DEFAULT_CLASSIFY_PROMPT).replaceAll('{{labels}}', labels.join(', '))
  const run = async () => {
    const started = Date.now()
    let model: string | undefined
    let expression: string | null = null
    let failure: string | undefined
    let answer = ''
    let request: unknown
    try {
      const connection = options.classifyConnectionId
        ? getApiPresetRow(options.classifyConnectionId)
        : resolveProfile(getChatRow(message.chatId)).connection!
      model = options.classifyModel || connection.model
      if (options.classifyContext === 'full') {
        answer = await quietPrompt({
          chatId: message.chatId,
          instruction: prompt,
          connectionId: connection.id,
          model,
          maxTokens: 20,
        })
      } else {
        const ctx = loadGenerationContext(message.chatId, { requireConnection: false })
        const body = buildRequestBody({
          model,
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: toDisplayText(message.content, { knownNames: [speaker.name], speaker: 'plain' }) },
          ],
          samplers: { ...ctx.preset.samplers, stream: false, maxTokens: 20 },
        })
        body.stream = false
        body.max_tokens = 20
        delete body.stream_options
        delete body.tools
        delete body.tool_choice
        request = body
        for await (const chunk of chatCompletion({
          connection: toLlmConnection(connection),
          body,
          signal: AbortSignal.timeout(60000),
        }))
          answer += chunk.text ?? ''
      }
      expression = extractExpressionLabel(answer, labels)
      if (!expression) throw new Error(t('模型没有返回有效的表情标签'))
    } catch (error) {
      failure = error instanceof Error ? error.message : t('情绪判断失败')
    }
    insertLog({
      chatId: message.chatId,
      messageId,
      kind: 'extension',
      status: failure ? 'error' : 'ok',
      model,
      durationMs: Date.now() - started,
      summary: t('情绪判断：{result}', { result: failure ?? expression ?? '' }),
      request,
      response: { answer, error: failure },
    })
    const latest = db.select().from(messages).where(eq(messages.id, messageId)).get()
    // 期间被编辑、续写或重新解析过（状态不再是 pending）就丢弃这次结果；只改了图片等其他元数据不影响
    if (!latest || latest.content !== message.content || latest.meta.stage?.classify !== 'pending') return
    db.update(messages)
      .set({
        meta: {
          ...latest.meta,
          stage: {
            ...latest.meta.stage,
            classify: failure ? 'error' : 'done',
            ops: expression ? [...latest.meta.stage.ops, { op: 'expr', who, expression }] : latest.meta.stage.ops,
          },
        },
      })
      .where(eq(messages.id, messageId))
      .run()
  }
  void run().catch((error) => logError(t('情绪判断后台任务'), error))
}
