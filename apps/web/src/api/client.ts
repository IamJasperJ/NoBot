import type {
  ApiPresetDTO,
  ApiPresetInput,
  AppSettings,
  AttachmentDTO,
  BackgroundDTO,
  BackgroundFolderDTO,
  BackgroundFolderInput,
  BackgroundSettings,
  BookmarkDTO,
  CharacterDTO,
  CharacterImportLorebook,
  CharacterImportPreview,
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
  PlayPresetData,
  PlayPresetDTO,
  PresetData,
  ProfileDTO,
  ProfileInput,
  PromptPresetDTO,
  PromptPreview,
  ResolvedProfileDTO,
  SpriteDTO,
  SpriteImportResult,
  StageState,
  SummaryStateDTO,
  SwipeInput,
  TestConnectionInput,
  TestConnectionResult,
  ToolInfo,
  TrashDTO,
  UpdateBackgroundInput,
  UpdateChatInput,
  UpdateSpriteInput,
  UsageDTO,
  WorldInfoSettings,
} from '@ai-parter/shared'
import { t } from '../i18n'

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
    data?.error?.message ?? t('请求失败（{status}）', { status: res.status }),
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
  listProfiles: () => request<ProfileDTO[]>('GET', '/profiles'),
  createProfile: (input: ProfileInput) => request<ProfileDTO>('POST', '/profiles', input),
  updateProfile: (id: string, input: ProfileInput) => request<ProfileDTO>('PUT', `/profiles/${enc(id)}`, input),
  deleteProfile: (id: string) => request<{ ok: true }>('DELETE', `/profiles/${enc(id)}`),
  setDefaultProfile: (id: string | null) => request<{ ok: true }>('PUT', '/profiles/default', { id }),
  getChatProfile: (id: string) => request<ResolvedProfileDTO>('GET', `/chats/${enc(id)}/profile`),
  regenerateCaption: (id: string, chatId?: string) =>
    request<AttachmentDTO>('POST', `/ext/caption/attachments/${enc(id)}`, { chatId }),
  importBackgroundUrl: (input: { url: string; name?: string }) =>
    request<BackgroundDTO>('POST', '/backgrounds/import-url', input),
  autoBackground: (chatId: string) =>
    request<{ background: BackgroundDTO; reply: string }>('POST', '/backgrounds/auto', { chatId }),
  listBackgrounds: (folderId?: string) =>
    request<BackgroundDTO[]>('GET', `/backgrounds${folderId === undefined ? '' : `?folderId=${enc(folderId)}`}`),
  listBackgroundFolders: () => request<BackgroundFolderDTO[]>('GET', '/backgrounds/folders'),
  createBackgroundFolder: (input: BackgroundFolderInput) =>
    request<BackgroundFolderDTO>('POST', '/backgrounds/folders', input),
  updateBackgroundFolder: (id: string, input: Partial<BackgroundFolderInput>) =>
    request<BackgroundFolderDTO>('PATCH', `/backgrounds/folders/${enc(id)}`, input),
  deleteBackgroundFolder: (id: string) => request<Ok>('DELETE', `/backgrounds/folders/${enc(id)}`),
  addBackgroundsToFolder: (input: { folderId: string; backgroundIds: string[] }) =>
    request<Ok>('POST', '/backgrounds/folders/add', input),
  removeBackgroundsFromFolder: (input: { folderId: string; backgroundIds: string[] }) =>
    request<Ok>('POST', '/backgrounds/folders/remove', input),
  batchDeleteBackgrounds: (ids: string[]) => request<Ok>('POST', '/backgrounds/batch-delete', { ids }),
  uploadBackground: (file: File, name?: string) => {
    const form = new FormData()
    form.append('file', file)
    if (name !== undefined) form.append('name', name)
    return request<BackgroundDTO>('POST', '/backgrounds', form)
  },
  /** 改名字、描述，或者把会话生成的背景设为公共（chatId: null） */
  updateBackground: (id: string, input: UpdateBackgroundInput) =>
    request<BackgroundDTO>('PATCH', `/backgrounds/${enc(id)}`, input),
  deleteBackground: (id: string) => request<Ok>('DELETE', `/backgrounds/${enc(id)}`),
  getBackgroundSettings: () => request<BackgroundSettings>('GET', '/backgrounds/settings'),
  setBackgroundSettings: (input: BackgroundSettings) =>
    request<BackgroundSettings>('PUT', '/backgrounds/settings', input),
  uploadAttachment: (file: File, chatId?: string) => {
    const form = new FormData()
    form.append('file', file)
    if (chatId) form.append('chatId', chatId)
    return request<AttachmentDTO>('POST', '/attachments', form)
  },
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

  // ---- 立绘（VN 模式） ----
  listSprites: (characterId: string) => request<SpriteDTO[]>('GET', `/characters/${characterId}/sprites`),
  /** 上传多张立绘；不给 expression 时后端按文件名推断（joy.png、joy-2.png） */
  uploadSprites: (characterId: string, files: File[], opts: { outfit?: string; expression?: string } = {}) => {
    const form = new FormData()
    for (const file of files) form.append('files', file)
    if (opts.outfit !== undefined) form.append('outfit', opts.outfit)
    if (opts.expression) form.append('expression', opts.expression)
    return request<SpriteImportResult>('POST', `/characters/${characterId}/sprites`, form)
  },
  /** 导入立绘包 zip（酒馆的扁平包，或一层目录 = 一套服装） */
  /** 导入立绘包：根目录下的图片归入 outfit 这套服装，子目录各自成为一套 */
  importSprites: (characterId: string, file: File, outfit = '') => {
    const form = new FormData()
    form.append('file', file)
    form.append('outfit', outfit)
    return request<SpriteImportResult>('POST', `/characters/${characterId}/sprites/import`, form)
  },
  deleteSprites: (characterId: string, ids: string[]) =>
    request<{ deleted: number }>('POST', `/characters/${characterId}/sprites/delete`, { ids }),
  updateSprite: (characterId: string, spriteId: string, input: UpdateSpriteInput) =>
    request<SpriteDTO>('PATCH', `/characters/${characterId}/sprites/${spriteId}`, input),
  deleteSprite: (characterId: string, spriteId: string) =>
    request<Ok>('DELETE', `/characters/${characterId}/sprites/${spriteId}`),
  deleteOutfit: (characterId: string, outfit: string) =>
    request<{ deleted: number }>('DELETE', `/characters/${characterId}/sprites?outfit=${encodeURIComponent(outfit)}`),

  // ---- 玩法预设（VN 模式） ----
  listPlayPresets: () => request<PlayPresetDTO[]>('GET', '/play-presets'),
  createPlayPreset: (input: { name: string; data: PlayPresetData }) =>
    request<PlayPresetDTO>('POST', '/play-presets', input),
  updatePlayPreset: (id: string, input: { name?: string; data?: PlayPresetData }) =>
    request<PlayPresetDTO>('PATCH', `/play-presets/${id}`, input),
  deletePlayPreset: (id: string) => request<Ok>('DELETE', `/play-presets/${id}`),
  setDefaultPlayPreset: (id: string) => request<Ok>('POST', `/play-presets/${id}/default`),
  duplicatePlayPreset: (id: string) => request<PlayPresetDTO>('POST', `/play-presets/${id}/duplicate`),
  resetPlayPreset: (id: string) => request<PlayPresetDTO>('POST', `/play-presets/${id}/reset`),
  restoreBuiltinPlayPresets: () => request<{ restored: number }>('POST', '/play-presets/restore-builtins'),
  importPlayPreset: (file: File) => upload<PlayPresetDTO>('/play-presets/import', file),
  exportPlayPreset: (id: string) => downloadUrl(`/play-presets/${id}/export`),

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
  previewCharacterImport: (file: File) => upload<CharacterImportPreview>('/characters/import/preview', file),
  importCharacter: (file: File, lorebook?: CharacterImportLorebook) =>
    upload<CharacterDTO>(`/characters/import${lorebook ? `?lorebook=${lorebook}` : ''}`, file),
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
  /** 某条消息之前的舞台和变量（VN 重演旧回复时用） */
  getStageBefore: (chatId: string, messageId: string) =>
    request<{ stage: StageState | null; vars: Record<string, unknown> }>(
      'GET',
      `/chats/${chatId}/stage?before=${encodeURIComponent(messageId)}`,
    ),
  /** HUD 里手动改变量（null 表示删除），返回改完后的整份变量 */
  setVars: (chatId: string, set: Record<string, unknown>) =>
    request<{ vars: Record<string, unknown> }>('POST', `/chats/${chatId}/vars`, { set }),
  /** VN 存档（书签的一种，带舞台快照）；读档用 activateMessage */
  createSave: (chatId: string, input: { messageId?: string; name?: string } = {}) =>
    request<BookmarkDTO>('POST', `/chats/${chatId}/saves`, input),
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
  updateMessageImageIndex: (id: string, imageIndex: number) =>
    request<MessageDTO>('PATCH', `/messages/${enc(id)}/meta`, { imageIndex }),
  /** reasoning：传字符串替换思考过程，空串删除，不传不动 */
  editMessage: (id: string, content: string, reasoning?: string) =>
    request<MessageDTO>('PATCH', `/messages/${id}`, { content, ...(reasoning === undefined ? {} : { reasoning }) }),
  /** 批量排除于上下文 / 恢复发送；返回所有改动过的消息（含自动带上的工具调用配对） */
  excludeMessages: (chatId: string, messageIds: string[], excluded: boolean) =>
    request<MessageDTO[]>('POST', `/chats/${chatId}/exclude`, { messageIds, excluded }),
  /** 上移 / 下移：生成一条交换了顺序的新分支，返回新的激活叶子 */
  moveMessage: (chatId: string, messageId: string, direction: 'up' | 'down') =>
    request<{ leafId: string }>('POST', `/chats/${chatId}/move`, { messageId, direction }),
  /** 切到某个节点所在的分支 */
  activateMessage: (chatId: string, messageId: string, exact = false) =>
    request<{ leafId: string }>('POST', `/chats/${chatId}/activate`, { messageId, exact }),

  // ---- 剧情总结（内置扩展 summary，扩展关闭时这些接口 404） ----
  summaryState: (chatId: string) =>
    request<SummaryStateDTO>('GET', `/ext/summary/state?chatId=${encodeURIComponent(chatId)}`),
  runSummary: (chatId: string) => request<SummaryStateDTO>('POST', '/ext/summary/run', { chatId }),
  editSummary: (chatId: string, messageId: string, text: string) =>
    request<SummaryStateDTO>('PATCH', '/ext/summary/entry', { chatId, messageId, text }),
  deleteSummary: (chatId: string, messageId: string) =>
    request<SummaryStateDTO>('DELETE', '/ext/summary/entry', { chatId, messageId }),
  freezeSummary: (chatId: string, frozen: boolean) =>
    request<SummaryStateDTO>('POST', '/ext/summary/freeze', { chatId, frozen }),

  // ---- 应用设置（界面语言等） ----
  getAppSettings: () => request<AppSettings>('GET', '/app-settings'),
  updateAppSettings: (input: AppSettings) => request<AppSettings>('PUT', '/app-settings', input),

  // ---- 回收站（删除角色 / 群组先进回收站） ----
  characterUsage: (id: string) => request<UsageDTO>('GET', `/characters/${id}/usage`),
  groupUsage: (id: string) => request<UsageDTO>('GET', `/groups/${id}/usage`),
  listTrash: () => request<TrashDTO>('GET', '/trash'),
  restoreTrash: (kind: 'character' | 'group', id: string) =>
    request<Ok>('POST', `/trash/${kind === 'character' ? 'characters' : 'groups'}/${id}/restore`),
  purgeTrash: (kind: 'character' | 'group', id: string) =>
    request<Ok>('DELETE', `/trash/${kind === 'character' ? 'characters' : 'groups'}/${id}`),
  emptyTrash: () => request<{ deleted: number }>('DELETE', '/trash'),

  // ---- 书签 ----
  listBookmarks: (chatId: string) => request<BookmarkDTO[]>('GET', `/chats/${chatId}/bookmarks`),
  createBookmark: (chatId: string, messageId: string, name?: string) =>
    request<BookmarkDTO>('POST', `/chats/${chatId}/bookmarks`, { messageId, ...(name ? { name } : {}) }),
  renameBookmark: (id: string, name: string) => request<BookmarkDTO>('PATCH', `/bookmarks/${id}`, { name }),
  deleteBookmark: (id: string) => request<Ok>('DELETE', `/bookmarks/${id}`),
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
