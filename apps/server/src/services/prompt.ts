import { buildPrompt, PromptBudgetError, type PromptContext } from '@ai-parter/core'
import type { MessageRole, PromptPreview } from '@ai-parter/shared'
import type { ApiPresetRow, ChatRow } from '../db/schema'
import { HttpError } from '../errors'
import { getCharacterRow, toFields } from './characters'
import { loadPath } from './chats'
import { resolvePersona } from './personas'
import { resolveApiPreset } from './presets'

/**
 * 收集上下文 → 调用 core 里的纯函数 buildPrompt。
 * 这是 Prompt 组装管线的第 1 阶段，之后全是纯计算。
 *
 * @param parentId 新回复要挂在哪条消息下面（它和它的祖先就是历史）
 * @param pending  还没入库的用户消息（send 模式下先组装、成功后才入库）
 */
export function assemblePrompt(
  chat: ChatRow,
  parentId: string | null,
  pending?: { role: MessageRole; content: string },
): PromptPreview & { preset: ApiPresetRow } {
  const preset = resolveApiPreset(chat.apiPresetId)
  const persona = resolvePersona(chat.personaId)
  const history: PromptContext['history'] = loadPath(parentId)
    .filter((m) => m.status !== 'error')
    .map((m) => ({ id: m.id, role: m.role, content: m.content }))
  if (pending) history.push({ id: 'pending', ...pending })

  try {
    const { messages, report } = buildPrompt({
      character: toFields(getCharacterRow(chat.characterId)),
      persona: { name: persona.name, description: persona.description },
      history,
      api: { contextSize: preset.contextSize, maxTokens: preset.params.max_tokens },
      chat: {
        id: chat.id,
        leafId: parentId,
        authorNote: chat.authorNote,
        authorNoteDepth: chat.authorNoteDepth,
      },
      now: new Date(),
    })
    return { messages, report, preset }
  } catch (e) {
    if (e instanceof PromptBudgetError) throw new HttpError(400, 'PROMPT_TOO_LONG', e.message)
    throw e
  }
}
