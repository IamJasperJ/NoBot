import type {
  ApiPresetDTO,
  ApiPresetInput,
  CharacterDTO,
  CharacterSummary,
  ChatDTO,
  ChatPage,
  ChatSummary,
  CreateChatInput,
  MessageDTO,
  PersonaDTO,
  PersonaInput,
  PromptPreview,
  SwipeInput,
  TestConnectionInput,
  TestConnectionResult,
  UpdateChatInput,
} from '@ai-parter/shared'

/** 后端返回的错误。message 是可以直接展示给用户的中文提示 */
export class ApiRequestError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message)
  }
}

/** 从响应里读出后端的错误信息 */
export async function readError(res: Response): Promise<ApiRequestError> {
  const data = await res.json().catch(() => null)
  return new ApiRequestError(
    data?.error?.code ?? 'HTTP',
    data?.error?.message ?? `请求失败（${res.status}）`,
    res.status,
  )
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : undefined,
    body: isForm ? body : body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw await readError(res)
  return (await res.json()) as T
}

const enc = encodeURIComponent

/** 所有后端接口。路径和后端 app.ts 里的路由一一对应 */
export const api = {
  // 角色
  listCharacters: () => request<CharacterSummary[]>('GET', '/characters'),
  getCharacter: (id: string) => request<CharacterDTO>('GET', `/characters/${id}`),
  importCharacter: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<CharacterDTO>('POST', '/characters/import', form)
  },
  deleteCharacter: (id: string) => request<{ ok: true }>('DELETE', `/characters/${id}`),

  // 会话
  listChats: (characterId: string) => request<ChatSummary[]>('GET', `/chats?characterId=${enc(characterId)}`),
  createChat: (input: CreateChatInput) => request<ChatDTO>('POST', '/chats', input),
  getChatPage: (chatId: string, before?: string) =>
    request<ChatPage>('GET', `/chats/${chatId}${before ? `?before=${enc(before)}` : ''}`),
  updateChat: (chatId: string, input: UpdateChatInput) => request<ChatDTO>('PATCH', `/chats/${chatId}`, input),
  deleteChat: (chatId: string) => request<{ ok: true }>('DELETE', `/chats/${chatId}`),
  swipe: (chatId: string, input: SwipeInput) =>
    request<{ leafId: string | null }>('POST', `/chats/${chatId}/swipe`, input),
  abort: (chatId: string) => request<{ ok: true }>('POST', `/chats/${chatId}/abort`),
  promptPreview: (chatId: string, text?: string) =>
    request<PromptPreview>('POST', `/chats/${chatId}/prompt-preview`, { text }),

  // 消息
  editMessage: (id: string, content: string) => request<MessageDTO>('PATCH', `/messages/${id}`, { content }),
  deleteMessage: (id: string) => request<{ ok: true }>('DELETE', `/messages/${id}`),

  // API 预设
  listApiPresets: () => request<ApiPresetDTO[]>('GET', '/presets/api'),
  createApiPreset: (input: ApiPresetInput) => request<ApiPresetDTO>('POST', '/presets/api', input),
  updateApiPreset: (id: string, input: ApiPresetInput) => request<ApiPresetDTO>('PATCH', `/presets/api/${id}`, input),
  deleteApiPreset: (id: string) => request<{ ok: true }>('DELETE', `/presets/api/${id}`),
  setDefaultApiPreset: (id: string) => request<{ ok: true }>('POST', `/presets/api/${id}/default`),
  testConnection: (input: TestConnectionInput) => request<TestConnectionResult>('POST', '/presets/api/test', input),

  // 人设
  listPersonas: () => request<PersonaDTO[]>('GET', '/personas'),
  updatePersona: (id: string, input: PersonaInput) => request<PersonaDTO>('PATCH', `/personas/${id}`, input),
}
