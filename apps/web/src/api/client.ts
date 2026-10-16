import type {
  ApiPresetDTO,
  ApiPresetInput,
  CharacterDTO,
  CharacterInput,
  CharacterSummary,
  CharacterUpdateInput,
  ChatDTO,
  ChatPage,
  ChatSummary,
  CreateChatInput,
  ExtensionDTO,
  GenerationLogDTO,
  GenerationLogSummary,
  GenerationType,
  GroupDTO,
  GroupInput,
  LorebookDTO,
  LorebookEntryData,
  LorebookEntryDTO,
  LorebookInput,
  MessageDTO,
  PersonaDTO,
  PersonaInput,
  PersonaUpdateInput,
  PresetData,
  PromptPresetDTO,
  PromptPreview,
  SwipeInput,
  TestConnectionInput,
  TestConnectionResult,
  ToolInfo,
  UpdateChatInput,
  WorldInfoSettings,
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

/** 上传单个文件（字段名 file） */
function upload<T>(path: string, file: File) {
  const form = new FormData()
  form.append('file', file)
  return request<T>('POST', path, form)
}

/** 下载文件：后端返回附件，浏览器直接保存 */
export function downloadUrl(path: string) {
  const a = document.createElement('a')
  a.href = `/api${path}`
  a.download = ''
  a.click()
}

type Ok = { ok: true }

/** 所有后端接口。路径和 apps/server/API.md 一一对应 */
export const api = {
  // ---- 连接 ----
  listConnections: () => request<ApiPresetDTO[]>('GET', '/connections'),
  createConnection: (input: ApiPresetInput) => request<ApiPresetDTO>('POST', '/connections', input),
  updateConnection: (id: string, input: ApiPresetInput) => request<ApiPresetDTO>('PATCH', `/connections/${id}`, input),
  deleteConnection: (id: string) => request<Ok>('DELETE', `/connections/${id}`),
  setDefaultConnection: (id: string) => request<Ok>('POST', `/connections/${id}/default`),
  testConnection: (input: TestConnectionInput) => request<TestConnectionResult>('POST', '/connections/test', input),

  // ---- 生成预设 ----
  listPresets: () => request<PromptPresetDTO[]>('GET', '/presets'),
  getPreset: (id: string) => request<PromptPresetDTO>('GET', `/presets/${id}`),
  createPreset: (input: { name: string; data: PresetData }) => request<PromptPresetDTO>('POST', '/presets', input),
  updatePreset: (id: string, input: { name?: string; data?: PresetData }) =>
    request<PromptPresetDTO>('PATCH', `/presets/${id}`, input),
  deletePreset: (id: string) => request<Ok>('DELETE', `/presets/${id}`),
  setDefaultPreset: (id: string) => request<Ok>('POST', `/presets/${id}/default`),
  duplicatePreset: (id: string) => request<PromptPresetDTO>('POST', `/presets/${id}/duplicate`),
  importPreset: (file: File) => upload<PromptPresetDTO>('/presets/import', file),
  exportPreset: (id: string) => downloadUrl(`/presets/${id}/export`),

  // ---- 人设 ----
  listPersonas: () => request<PersonaDTO[]>('GET', '/personas'),
  createPersona: (input: PersonaInput) => request<PersonaDTO>('POST', '/personas', input),
  updatePersona: (id: string, input: PersonaUpdateInput) => request<PersonaDTO>('PATCH', `/personas/${id}`, input),
  deletePersona: (id: string) => request<Ok>('DELETE', `/personas/${id}`),
  setDefaultPersona: (id: string) => request<Ok>('POST', `/personas/${id}/default`),
  setPersonaAvatar: (id: string, file: File) => upload<PersonaDTO>(`/personas/${id}/avatar`, file),
  removePersonaAvatar: (id: string) => request<PersonaDTO>('DELETE', `/personas/${id}/avatar`),

  // ---- 角色 ----
  listCharacters: () => request<CharacterSummary[]>('GET', '/characters'),
  getCharacter: (id: string) => request<CharacterDTO>('GET', `/characters/${id}`),
  createCharacter: (input: CharacterInput) => request<CharacterDTO>('POST', '/characters', input),
  importCharacter: (file: File) => upload<CharacterDTO>('/characters/import', file),
  updateCharacter: (id: string, input: CharacterUpdateInput) =>
    request<CharacterDTO>('PATCH', `/characters/${id}`, input),
  deleteCharacter: (id: string) => request<Ok>('DELETE', `/characters/${id}`),
  duplicateCharacter: (id: string) => request<CharacterDTO>('POST', `/characters/${id}/duplicate`),
  setCharacterAvatar: (id: string, file: File) => upload<CharacterDTO>(`/characters/${id}/avatar`, file),
  exportCharacter: (id: string, format: 'png' | 'json') => downloadUrl(`/characters/${id}/export?format=${format}`),

  // ---- 世界书 ----
  listLorebooks: () => request<LorebookDTO[]>('GET', '/lorebooks'),
  createLorebook: (input: LorebookInput) => request<LorebookDTO>('POST', '/lorebooks', input),
  getLorebook: (id: string) =>
    request<{ lorebook: LorebookDTO; entries: LorebookEntryDTO[] }>('GET', `/lorebooks/${id}`),
  updateLorebook: (id: string, input: Partial<LorebookInput>) =>
    request<LorebookDTO>('PATCH', `/lorebooks/${id}`, input),
  deleteLorebook: (id: string) => request<Ok>('DELETE', `/lorebooks/${id}`),
  importLorebook: (file: File) => upload<LorebookDTO>('/lorebooks/import', file),
  exportLorebook: (id: string) => downloadUrl(`/lorebooks/${id}/export`),
  createEntry: (lorebookId: string, data: Partial<LorebookEntryData>) =>
    request<LorebookEntryDTO>('POST', `/lorebooks/${lorebookId}/entries`, data),
  updateEntry: (entryId: string, data: Partial<LorebookEntryData>) =>
    request<LorebookEntryDTO>('PATCH', `/lorebooks/entries/${entryId}`, data),
  deleteEntry: (entryId: string) => request<Ok>('DELETE', `/lorebooks/entries/${entryId}`),
  reorderEntries: (lorebookId: string, ids: string[]) =>
    request<Ok>('POST', `/lorebooks/${lorebookId}/entries/reorder`, { ids }),
  getWorldInfoSettings: () => request<WorldInfoSettings>('GET', '/lorebooks/settings'),
  setWorldInfoSettings: (s: WorldInfoSettings) => request<WorldInfoSettings>('PUT', '/lorebooks/settings', s),

  // ---- 群组 ----
  listGroups: () => request<GroupDTO[]>('GET', '/groups'),
  getGroup: (id: string) => request<GroupDTO>('GET', `/groups/${id}`),
  createGroup: (input: GroupInput) => request<GroupDTO>('POST', '/groups', input),
  updateGroup: (id: string, input: Partial<GroupInput>) => request<GroupDTO>('PATCH', `/groups/${id}`, input),
  deleteGroup: (id: string) => request<Ok>('DELETE', `/groups/${id}`),

  // ---- 会话 ----
  listChats: (filter: { characterId?: string; groupId?: string }) =>
    request<ChatSummary[]>(
      'GET',
      `/chats?${filter.characterId ? `characterId=${enc(filter.characterId)}` : `groupId=${enc(filter.groupId ?? '')}`}`,
    ),
  createChat: (input: CreateChatInput) => request<ChatDTO>('POST', '/chats', input),
  getChatPage: (chatId: string, before?: string) =>
    request<ChatPage>('GET', `/chats/${chatId}${before ? `?before=${enc(before)}` : ''}`),
  updateChat: (chatId: string, input: UpdateChatInput) => request<ChatDTO>('PATCH', `/chats/${chatId}`, input),
  deleteChat: (chatId: string) => request<Ok>('DELETE', `/chats/${chatId}`),
  swipe: (chatId: string, input: SwipeInput) =>
    request<{ leafId: string | null }>('POST', `/chats/${chatId}/swipe`, input),
  branch: (chatId: string, messageId: string) => request<ChatDTO>('POST', `/chats/${chatId}/branch`, { messageId }),
  abort: (chatId: string) => request<Ok>('POST', `/chats/${chatId}/abort`),
  promptPreview: (chatId: string, opts: { type?: GenerationType; text?: string } = {}) =>
    request<PromptPreview>('POST', `/chats/${chatId}/prompt-preview`, opts),

  // ---- 消息 ----
  editMessage: (id: string, content: string) => request<MessageDTO>('PATCH', `/messages/${id}`, { content }),
  deleteMessage: (id: string) => request<Ok>('DELETE', `/messages/${id}`),

  // ---- 日志 ----
  listLogs: (opts: { chatId?: string; limit?: number } = {}) =>
    request<GenerationLogSummary[]>(
      'GET',
      `/logs?${new URLSearchParams(Object.entries(opts).map(([k, v]) => [k, String(v)])).toString()}`,
    ),
  getLog: (id: string) => request<GenerationLogDTO>('GET', `/logs/${id}`),
  clearLogs: () => request<Ok>('DELETE', '/logs'),

  // ---- 扩展 ----
  listExtensions: () => request<ExtensionDTO[]>('GET', '/extensions'),
  updateExtension: (id: string, patch: { enabled?: boolean; settings?: Record<string, unknown> }) =>
    request<ExtensionDTO>('PATCH', `/extensions/${id}`, patch),
  listTools: () => request<ToolInfo[]>('GET', '/extensions/tools'),
}
