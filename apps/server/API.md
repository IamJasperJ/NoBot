# 后端接口约定

下表路径统一省略 `/api` 前缀。除文件下载、静态资源和 SSE 外，请求和返回均为 JSON；上传用 multipart，通常字段名为 `file`（立绘批量上传为 `files`）。
除特别注明的服务端 schema 外，类型名来自 `packages/shared`。出错时返回 `{ error: { code, message } }`，`message` 按应用语言（中文 / 英文）返回。

通用约定：

- 列表的结构和排序以各接口为准；会话消息按从旧到新排列
- `PATCH` 只更新传了的字段
- 表格中的 ok 表示 `{ ok: true }`；批量删除等例外单独列出
- 找不到资源通常返回 404，`code` 为 `NOT_FOUND`；无生成任务时为 `NO_JOB`
- 「默认」的概念统一存在 settings 表（键见 `services/settings.ts` 的 `SETTING_KEYS`）

## 连接 `/connections`

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| GET | `/connections` | 获取列表 | — | `ApiPresetDTO[]` |
| POST | `/connections` | 创建 | `ApiPresetInput` | `ApiPresetDTO` |
| PATCH | `/connections/:id` | 更新 | `apiPresetPatchInput`（服务端，连接字段可选） | `ApiPresetDTO` |
| DELETE | `/connections/:id` | 删除 | — | ok |
| POST | `/connections/:id/default` | 设为默认 | — | ok |
| POST | `/connections/test` | 测试连接 | `TestConnectionInput` | `TestConnectionResult` |

连接的 `provider` 默认为 `custom`，`options` 默认为 `{}`。提供方与专用选项见共享契约 `providers.ts`：
`azure_openai` 使用 `deployment` / `apiVersion`，`workers_ai` 使用 `accountId`，`vertexai` 使用
`authMode`（`express` / `service_account`）、`region`、`projectId`。选项默认值在调用模型时合并。
Vertex 服务账号模式的 `apiKey` 保存完整服务账号 JSON；响应仅返回打码后的 `apiKeyMasked`。
PATCH 不传 `provider` / `options` 时保留原值；传 `options` 时完整替换已保存选项。

`POST /connections/test` 支持草稿的 `provider` / `options` 覆盖保存配置，Key 留空沿用已保存值。
模型列表按协议拉取，Gemini 仅返回支持 `generateContent` 的模型；静态目录提供方通过最小生成请求验证连接。
Azure 模型就是部署名，因此返回空模型列表。所有聊天、静默生成、分类和图片说明使用同一连接协议适配层；日志保留转换前的 OpenAI 请求格式。

## 生成预设 `/presets`

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| GET | `/presets` | 获取列表 | — | `PromptPresetDTO[]` |
| GET | `/presets/:id` | 获取详情 | — | `PromptPresetDTO` |
| POST | `/presets` | 创建 | `PromptPresetInput` | `PromptPresetDTO` |
| PATCH | `/presets/:id` | 更新 | `{ name?, data? }`（data 是完整的 PresetData） | `PromptPresetDTO` |
| DELETE | `/presets/:id` | 删除 | — | ok（不能删最后一个，返回 400 `LAST_PRESET`） |
| POST | `/presets/:id/default` | 设为默认 | — | ok |
| POST | `/presets/:id/duplicate` | 复制 | — | `PromptPresetDTO`（名字加「 副本」） |
| POST | `/presets/import` | 导入 | multipart `file`（酒馆预设 JSON） | `PromptPresetDTO`（名字取文件名去掉扩展名） |
| GET | `/presets/:id/export` | 导出 | — | 酒馆格式 JSON，`Content-Disposition: attachment; filename*=UTF-8''<名字>.json` |

- 数据库存的 data 读出来时一律经 `presetDataSchema.parse` 补齐默认值
- 删除默认预设后，把剩下的第一个设为默认

## 人设 `/personas`

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| GET | `/personas` | 获取列表 | — | `PersonaDTO[]` |
| POST | `/personas` | 创建 | `PersonaInput` | `PersonaDTO` |
| PATCH | `/personas/:id` | 更新 | `PersonaUpdateInput` | `PersonaDTO` |
| DELETE | `/personas/:id` | 删除 | — | ok（不能删最后一个，返回 400 `LAST_PERSONA`；删的是默认人设时把第一个设为默认） |
| POST | `/personas/:id/default` | 设为默认 | — | ok |
| POST | `/personas/:id/avatar` | 设置头像 | multipart `file`（任意图片） | `PersonaDTO` |
| DELETE | `/personas/:id/avatar` | 删除头像 | — | `PersonaDTO` |

头像用 `lib/files.ts` 的 `saveAvatar` / `deleteAvatar` / `avatarUrl`。

## 角色 `/characters`

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| GET | `/characters` | 获取列表 | — | `CharacterSummary[]` |
| GET | `/characters/:id/cgs` | 获取详情 | — | `CharacterCgDTO[]`（角色关联会话中标记为 CG 的附件） |
| GET | `/characters/:id/usage` | 获取详情 | — | `UsageDTO`（删除前查看会话数和所属群组） |
| GET | `/characters/:id` | 获取详情 | — | `CharacterDTO` |
| POST | `/characters` | 创建 | `CharacterInput`（新建空白角色） | `CharacterDTO` |
| POST | `/characters/import/preview` | 预读角色卡 | multipart `file`（PNG / JSON 角色卡） | `CharacterImportPreview`（只解析，不保存角色、世界书或头像） |
| POST | `/characters/import?lorebook=link\|import\|skip` | 导入 | multipart `file`（PNG / JSON 角色卡），query 缺省 `skip` | `CharacterDTO` |
| PATCH | `/characters/:id` | 更新 | `CharacterUpdateInput` | `CharacterDTO` |
| DELETE | `/characters/:id` | 删除 | — | ok（移入回收站，保留会话和文件） |
| POST | `/characters/:id/duplicate` | 复制 | — | `CharacterDTO`（名字加「 副本」，复制头像和世界书关联） |
| POST | `/characters/:id/avatar` | 设置头像 | multipart `file`（任意图片） | `CharacterDTO` |
| GET | `/characters/:id/export?format=png\|json` | 导出 | — | 文件下载 |

- 预读返回 `{ name, spec: 'v1' | 'v2' | 'v3', hasAvatar, lorebook: { name, entryCount } | null }`。
  内嵌世界书用 core 的 `importSTWorldInfo` 解析并统计条目，名字取 book.name，没有则「<角色名> 的世界书」。
  角色卡或内嵌世界书解析失败返回 400 `BAD_CARD`。
- 导入的 `lorebook` 用 `characterImportLorebookSchema` 校验，非法值返回 400 `VALIDATION`：
  `link` 导入内嵌世界书并作为第一本关联；`import` 只导入世界书，不关联；`skip` 不导入世界书（缺省行为）。
  没有内嵌世界书时三种选项都只导入角色。extras（talkativeness、角色备注）用 `ParsedCard.extras`。
- 原始 `character_book` 保存在 raw；导出时优先嵌入当前关联的主世界书，没有关联时回退到原始内嵌数据，确保不丢内容。
- `lorebookIds` 的顺序存在 `character_lorebooks.position`，第一本是导出时嵌入的主世界书
- 导出 PNG：没有头像时用一张 400×600 的纯色占位图（sharp 生成）；用 core 的 `buildCardExport`
  得到 v2 / v3，分别 base64 后写进 `chara`、`ccv3` 文本块（`writePngTextChunks`）；导出 JSON 用 v3

## 世界书 `/lorebooks`

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| GET | `/lorebooks` | 获取列表 | — | `LorebookDTO[]` |
| POST | `/lorebooks` | 创建 | `LorebookInput` | `LorebookDTO` |
| GET | `/lorebooks/:id` | 获取详情 | — | `{ lorebook: LorebookDTO, entries: LorebookEntryDTO[] }`（entries 按 sort 升序） |
| PATCH | `/lorebooks/:id` | 更新 | `Partial<LorebookInput>` | `LorebookDTO` |
| DELETE | `/lorebooks/:id` | 删除 | — | ok |
| POST | `/lorebooks/import` | 导入 | multipart `file`（酒馆世界书 JSON 或角色卡内嵌格式） | `LorebookDTO`（名字取 json.name，没有则文件名） |
| GET | `/lorebooks/:id/export` | 导出 | — | 酒馆世界书 JSON 文件下载 |
| POST | `/lorebooks/:id/entries` | 创建 | `Partial<LorebookEntryData>` | `LorebookEntryDTO`（追加到末尾） |
| PATCH | `/lorebooks/entries/:entryId` | 更新 | `Partial<LorebookEntryData>` | `LorebookEntryDTO` |
| DELETE | `/lorebooks/entries/:entryId` | 删除 | — | ok |
| POST | `/lorebooks/:id/entries/reorder` | 调整条目顺序 | `{ ids: string[] }` | ok |
| GET | `/lorebooks/settings` | 获取列表 | — | `WorldInfoSettings` |
| PUT | `/lorebooks/settings` | 保存 | `WorldInfoSettings` | `WorldInfoSettings` |

注意 `/lorebooks/settings`、`/lorebooks/import`、`/lorebooks/entries/...` 要注册在 `/:id` 之前。
全局设置用 `services/settings.ts` 的 `getWorldInfoSettings` / `setWorldInfoSettings`。
`WorldInfoSettings` 包含扫描深度、预算、递归、匹配、插入顺序及最少激活数等设置；向量设置为：

| 字段 | 用途 / 默认值 |
| --- | --- |
| vectorEnabled | 开启向量检索，默认 false |
| embeddingConnectionId / embeddingModel | 嵌入连接（默认 null）和模型（默认空串） |
| vectorThreshold | 相似度阈值，默认 0.25 |
| vectorMaxEntries | 最大向量条目数，默认 5 |
| vectorQueryMessages | 用于检索的最近消息数，默认 2 |

条目的 `vectorized` 决定是否参与向量检索；世界书的 `isGlobal` 决定是否全局启用。

## 群组 `/groups`

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| GET | `/groups` | 获取列表 | — | `GroupDTO[]` |
| GET | `/groups/:id/usage` | 获取详情 | — | `UsageDTO`（删除前查看会话数） |
| GET | `/groups/:id` | 获取详情 | — | `GroupDTO` |
| POST | `/groups` | 创建 | `GroupInput` | `GroupDTO` |
| PATCH | `/groups/:id` | 更新 | `Partial<GroupInput>`（members 传了就整体替换） | `GroupDTO` |
| DELETE | `/groups/:id` | 删除 | — | ok（移入回收站，保留群聊会话） |

## 会话 `/chats`

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| GET | `/chats?characterId=&groupId=` | 获取列表 | — | `ChatSummary[]` |
| POST | `/chats` | 创建 | `CreateChatInput` | `ChatDTO` |
| GET | `/chats/:id?before=&limit=` | 获取详情 | — | `ChatPage` |
| GET | `/chats/:id/stage?before=` | 获取消息前的舞台和变量 | 必填消息 id | `{ stage: StageState \| null, vars }`（该消息之前的舞台和变量） |
| GET | `/chats/:id/profile` | 获取生效配置组 | — | `ResolvedProfileDTO`（实际生效的配置组和来源） |
| GET | `/chats/:id/bookmarks` | 获取详情 | — | `BookmarkDTO[]`（含书签与存档） |
| POST | `/chats/:id/bookmarks` | 创建 | `CreateBookmarkInput` | `BookmarkDTO`（创建书签） |
| POST | `/chats/:id/saves` | 创建 VN 存档 | `CreateSaveInput` | `BookmarkDTO`（创建带 `SaveSnapshot` 的 VN 存档） |
| POST | `/chats/:id/messages` | 创建 | `{ role: 'user' \| 'system', content }` | `MessageDTO`（直接追加，不调用模型） |
| POST | `/chats/:id/roll` | 掷骰并记录 | `{ expression }`，最长 100 字符 | `{ result }`（掷骰并追加系统消息） |
| POST | `/chats/:id/vars` | 修改会话变量 | `SetVarsInput`，`set` 中 null 表示删除 | `{ vars }`（更新后的全部变量） |
| POST | `/chats/:id/exclude` | 切换上下文排除 | `ExcludeMessagesInput` | `MessageDTO[]`（切换上下文排除状态，含配对工具消息） |
| POST | `/chats/:id/activate` | 切换分支 / 读档 | `ActivateMessageInput`，`exact: true` 精确读档 | `{ leafId }`（切换激活分支） |
| POST | `/chats/:id/move` | 调整消息顺序 | `MoveMessageInput` | `{ leafId }`（新建交换消息顺序的分支） |
| PATCH | `/chats/:id` | 更新 | `UpdateChatInput` | `ChatDTO` |
| DELETE | `/chats/:id` | 删除 | — | ok |
| POST | `/chats/:id/swipe` | 切换同级回复 | `SwipeInput` | `{ leafId }` |
| POST | `/chats/:id/branch` | 复制为新会话 | `branchInput`（messageId） | `ChatDTO`（复制路径为新会话） |
| POST | `/chats/:id/prompt-preview` | 预览 Prompt | `{ type?: GenerationType, text?, speakerId? }` | `PromptPreview`（组装 Prompt，不调用模型） |
| POST | `/chats/:id/generate` | 启动生成 | `GenerateInput` | SSE：`GenerateEvent` |
| GET | `/chats/:id/stream` | 重连生成流 | — | SSE：重新接上进行中的生成 |
| POST | `/chats/:id/abort` | 中止生成 | — | ok |
| POST | `/chats/:id/impersonate` | 代写用户消息 | — | SSE：`ImpersonateEvent` |

## 书签 / 存档 `/bookmarks`

创建和列表见 `/chats/:id/bookmarks`，存档创建见 `/chats/:id/saves`；读档用 `/chats/:id/activate` 的 `exact: true`。

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| PATCH | `/bookmarks/:id` | 重命名书签或存档 | `UpdateBookmarkInput` | `BookmarkDTO` |
| DELETE | `/bookmarks/:id` | 删除书签或存档 | — | ok |

## 消息 `/messages`

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| PATCH | `/messages/:id` | 编辑正文 / 思考内容 | `EditMessageInput` | `MessageDTO` |
| PATCH | `/messages/:id/meta` | 切换当前展示的图片 | `{ imageIndex }`（非负整数） | `MessageDTO` |
| DELETE | `/messages/:id` | 删除消息及子树 | — | ok |

## 日志 `/logs`

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| GET | `/logs?chatId=&limit=` | 查询日志摘要 | 可选会话 id、正整数条数 | `GenerationLogSummary[]` |
| GET | `/logs/:id` | 获取请求 / 响应详情 | — | `GenerationLogDTO` |
| DELETE | `/logs` | 清空日志 | — | ok |

## 扩展管理 `/extensions`

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| GET | `/extensions` | 列出内置和本地扩展 | — | `ExtensionDTO[]` |
| PATCH | `/extensions/:id` | 修改开关或整体替换设置 | `{ enabled?, settings?, approvePermissions? }` | `ExtensionDTO` |
| GET | `/extensions/tools` | 列出当前可用工具 | — | `ToolInfo[]` |
| GET | `/extensions/:id/client.js` | 获取前端脚本 | — | JavaScript |
| GET | `/extensions/:id/style.css` | 获取样式 | — | CSS |
| GET | `/extensions/git` | 检查系统 Git | — | `GitStatusDTO` |
| POST | `/extensions/install/preview` | 浅克隆暂存、只读 manifest 预览 | `{ url, ref? }` | `ExtensionInstallPreview` |
| POST | `/extensions/install/confirm` | 安装并可同时确认权限启用 | `{ token, enable? }` | `ExtensionDTO` |
| POST | `/extensions/install/cancel` | 删除暂存 | `{ token }` | `{ ok: true }` |
| POST | `/extensions/:id/check-update` | fetch 后检查上游提交 | — | `ExtensionDTO` |
| POST | `/extensions/:id/update` | 仅快进更新并热重载 | — | `ExtensionUpdateResult` |
| GET | `/extensions/:id/branches` | 分支及标签（含 origin 远端分支） | — | `{ current, branches }` |
| POST | `/extensions/:id/switch` | 切换并热重载 | `{ ref }` | `ExtensionDTO` |
| DELETE | `/extensions/:id` | 卸载本地扩展并删除设置和存储 | — | `{ ok: true }` |
| POST | `/extensions/reload` | 重扫本地目录并重载变化项 | — | `ExtensionDTO[]` |
| GET | `/extensions/catalog/sources` | 获取索引源 | — | `{ urls: string[] }` |
| PUT | `/extensions/catalog/sources` | 保存索引源（最多 20 个 HTTP/HTTPS URL） | `{ urls: string[] }` | `{ urls: string[] }` |
| GET | `/extensions/catalog` | 获取目录（`?refresh=1` 绕过 5 分钟缓存） | — | `ExtensionCatalogDTO` |

`ExtensionDTO` 还包含 permissions（未声明为 null）、detected、permissionWarnings、needsApproval、git 和 revision。
本地扩展未确认或权限集合超出已确认集合时不生效，enabled=true 未同时传 approvePermissions=true 返回
409 / `NEEDS_APPROVAL`。权限减少无需再次确认。network 仅声明，无法强制限制访问。
Git 地址仅允许 HTTPS 或 git@host:path，ref 支持分支和标签；预览不执行代码，token 30 分钟到期。
更新和切换拒绝有本地修改的仓库，内置扩展不可替换或卸载，非 Git 本地扩展调用 Git 接口返回 400。
热重载使用独立版本运行目录，移除旧路由、工具、宏和钩子，并调用可选 dispose 清理函数。
索引支持数组或 `{ extensions: [...] }`，逐项宽松校验，单源失败不影响其他源；每源 15 秒、2MB 上限。
示例扩展见 `examples/extensions/hello-world`。

## 扩展自定义接口 `/ext/:id`

扩展列表的 `ExtensionDTO` 还包含：`author`（未提供时为空字符串）、
`client: { script, style }`（是否声明前端脚本和样式）、`hasRoutes`（是否提供自定义接口或命令）、`commands`（`CommandDescription[]`）。
内置扩展在前，本地扩展按目录名排序；加载失败的目录仍显示在列表中，包含 `loadError` 且不可启用。
`PATCH /extensions/:id` 的 settings 整体替换用户配置，读取时与扩展默认设置浅合并。
secret 字段返回 `••••••••`，原样传回表示保留原值。停用不删除设置和扩展存储。

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| 任意 | `/ext/:id/*` | 转发给扩展 Hono 子应用 | 保留方法、查询、请求头与请求体，去掉挂载前缀 | 扩展接口的返回 |

前端资源设置 `Cache-Control: no-cache`；扩展停用、不存在、未声明资源或文件不可用返回 404。
资源接口没有任意路径参数，manifest 文件路径不得越过扩展目录（包括软链接）。
扩展未启用或未提供自定义接口时 `/ext/:id/*` 返回 404。错误统一使用 `{ error: { code, message } }`。
routes 在已确认权限的扩展每次加载版本时注册一次，ctx.settings 每次读取返回当前合并配置，ctx.storage 使用 settings 表中的
`extdata:<扩展id>:<key>` 命名空间。

宿主更新消息元数据时广播 `message:updated`。生成流程异步广播 `message:saved`（用户插入、助手最终保存、工具插入）和 `generation:complete`（任务 finally）；
创建会话后广播 `chat:created`。只有启用扩展接收事件，处理异常只记录日志。
示例扩展见 `examples/extensions/hello-world`。

### 扩展命令

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| POST | `/ext/:id/commands/:name` | 执行后端声明的命令（主名称） | `{ chatId?: string \| null, args: Record<string, string>, text: string }` | `{ result: string }` |

命令自动注册，描述通过 `ExtensionDTO.commands` 下发；别名由前端映射到主名称。
内置图片命令为 `/imagine`（别名 `/sd`），后端地址 `/ext/image-gen/commands/imagine`。

### 图片生成 `/ext/image-gen`

生成请求字段为 `{ chatId, mode, messageId?, input?, characterId?, prompt?, negative?, snapshotId? }`。
mode 为 `free / character / portrait / face / user / last / raw_last / scene / background`。
下表的「草稿」指 `{ settings?: Record<string, unknown>, chatId? }`，不保存设置，密钥占位串还原为保存值。

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| GET | `/ext/image-gen/background-status?chatId=` | 查询后台自动生成背景状态 | 会话 id | `{ running }` |
| POST | `/ext/image-gen/generate` | 生成图片并保存消息，背景模式同时设置背景 | 生成请求 | `{ message: MessageDTO, background?: BackgroundDTO }`（异步时先返回占位消息） |
| POST | `/ext/image-gen/prompt` | 预览并冻结绘图参数 | 生成请求 | `{ snapshotId, prompt, negative, width, height, source, model, workflow }` |
| POST | `/ext/image-gen/cancel` | 取消图片任务 | `{ messageId }` | `{ message: MessageDTO }` |
| POST | `/ext/image-gen/dismiss` | 放弃失败 / 已取消任务 | `{ messageId }` | `{ message: MessageDTO }` 或 `{ deleted: true }` |
| POST | `/ext/image-gen/retry` | 重试 / 追加另一张图片 | `{ messageId, append?: boolean, prompt?, negative? }`（append 默认 true） | `{ message: MessageDTO }` |
| POST | `/ext/image-gen/to-background` | 将消息图片存入背景库并应用 | `{ messageId, index? }`（默认 0） | `{ background: BackgroundDTO }` |
| POST | `/ext/image-gen/gallery-background` | 将图库图片应用到目标会话背景 | `{ chatId, messageId, imageId }` | `{ background: BackgroundDTO }` |
| POST | `/ext/image-gen/test` | 按草稿测试出图 | 草稿 | `{ image: AttachmentDTO, durationMs }` |
| POST | `/ext/image-gen/test-connection` | 按草稿测试图片连接 | 草稿 | `{ ok: true, message }` |
| POST | `/ext/image-gen/connections` | 列出连接候选 | — | `{ options: [{ value, label }] }` |
| POST | `/ext/image-gen/prompt/models` | 列出提示词模型候选 | 草稿 | `{ options: [{ value, label }] }` |
| POST | `/ext/image-gen/:backend/capabilities` | 查询后端能力和候选项 | 草稿 | 能力发现结果，含 capabilities |
| POST | `/ext/image-gen/:backend/models` | 拉取图片模型 | 草稿 | `{ options, models }` |
| POST | `/ext/image-gen/:backend/samplers` | 拉取采样器 | 草稿 | `{ options, samplers }` |
| POST | `/ext/image-gen/:backend/schedulers` | 拉取调度器 | 草稿 | `{ options, schedulers }` |
| POST | `/ext/image-gen/:backend/vaes` | 拉取 VAE | 草稿 | `{ options, vaes }` |
| POST | `/ext/image-gen/:backend/upscalers` | 拉取放大器 | 草稿 | `{ options, upscalers }` |
| POST | `/ext/image-gen/styles` | 列出草稿中的风格 | 草稿 | `{ options: [{ value, label }] }` |
| POST | `/ext/image-gen/comfy/workflows` | 列出内置和草稿工作流 | 草稿 | `{ options: [{ value, label }] }` |
| POST | `/ext/image-gen/comfy/workflow-inspection` | 检查当前工作流及占位符 | 草稿 | `{ error, placeholders: [{ name, used }] }` |
| POST | `/ext/image-gen/comfy/workflow-check` | 校验待导入工作流 | `{ json: string, settings? }` | `{ valid, error?, placeholders: [{ name, used }] }` |
| GET | `/ext/image-gen/gallery?characterId=&limit=&offset=` | 分页查看角色生成图库 | characterId 必填，limit 默认 40（1–100），offset 默认 0 | `{ images: { chatId, messageId, image: AttachmentDTO, prompt, createdAt }[], total }` |

`:backend` 仅为 `openai / comfy / a1111 / openrouter`，候选项均为 `{ value, label }`。

### 剧情总结 `/ext/summary`

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| GET | `/ext/summary/state?chatId=` | 获取激活分支的总结状态 | `summaryChatInput`（查询） | `SummaryStateDTO` |
| POST | `/ext/summary/run` | 立即总结并等待完成 | `SummaryChatInput` | `SummaryStateDTO` |
| PATCH | `/ext/summary/entry` | 编辑总结并取消自动标记 | `EditSummaryInput` | `SummaryStateDTO` |
| DELETE | `/ext/summary/entry` | 删除消息上的总结 | `DeleteSummaryInput`（JSON） | `SummaryStateDTO` |
| POST | `/ext/summary/freeze` | 暂停 / 恢复自动总结 | `FreezeSummaryInput` | `SummaryStateDTO` |
| POST | `/ext/summary/connections` | 列出连接候选 | — | `{ options: [{ value, label }] }` |
| POST | `/ext/summary/models` | 按设置草稿拉取模型 | `{ settings?, chatId? }` | `{ options: [{ value, label }] }` |

### 图片说明 `/ext/caption`

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| POST | `/ext/caption/attachments/:id` | 为附件生成 / 重试文字说明 | `{ chatId?: string }` | `AttachmentDTO`（生成失败时返回原附件） |

### 翻译 `/ext/translate`

扩展默认关闭，启用后可访问以下接口。实际路径均以 `/api` 开头。

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| POST | `/ext/translate/message` | 翻译正文和可选思考过程并保存 | `{ messageId, lang? }` | `MessageDTO` |
| DELETE | `/ext/translate/message` | 清除译文；source 输入同时恢复原文正文 | `{ messageId }` | `MessageDTO` |
| POST | `/ext/translate/text` | 翻译独立文本 | `{ text, lang?, chatId? }` | `{ text }` |
| POST | `/ext/translate/connections` | 连接候选 | `{ settings?, chatId? }` | `{ options: [{ value, label }] }` |
| POST | `/ext/translate/models` | 以草稿设置拉取模型 | `{ settings?, chatId? }` | `{ options: [{ value, label }] }` |
| POST | `/ext/translate/test` | 以草稿设置翻译固定文本 Hello, world! | `{ settings?, chatId? }` | `{ text }` |

`lang` 缺省使用 targetLanguage，设置留空则跟随界面语言。输入框要翻译为模型语言时传 `lang: internalLanguage`。
模型服务通过可选 `chatId` 跟随会话的连接和模型；无会话时跟随全局配置组。
草稿接口恢复未改动的密钥占位值；候选接口在扩展关闭时仍可访问，测试接口需要启用扩展。
服务 URL 配置为根地址，DeepLX / LibreTranslate 自动追加 `/translate`，Lingva 自动追加 `/api/v1/auto/...`。
`POST /ext/translate/commands/translate` 复用扩展命令协议 `{ chatId?, args: { lang? }, text }`，返回 `{ result }`。
命令文本留空时翻译当前分支最后一条已完成助手消息并保存，其他情况只返回译文。

手动消息翻译保存 `direction: display`、`auto: false` 和正文 SHA-256 `sourceHash`；
已有 source 原文的输入须先 DELETE 还原，避免覆盖其原文。翻译期间内容改变则返回 409。
服务请求失败或无效响应返回 502 `TRANSLATION_FAILED`（包含服务错误摘要），占位符损坏返回 502 `TRANSLATION_TOKEN`。
自动模式失败不会阻断发送和回复。自动回复翻译独立于生成完成；后端发出 `message:updated`，
前端需要轮询现有消息接口中的 `meta.translation` 与 `sourceHash`；当前没有 pending/error 共享状态字段。

正则替换扩展 `regex` 没有自定义路由。

## 图片附件 `/attachments`

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| POST | `/attachments` | 创建 | multipart `file`、可选 `chatId`，常见位图格式，单文件最多 10MB | `AttachmentDTO`（上传并按需生成 caption，含 isCg） |
| PATCH | `/attachments/:id` | 更新 | `{ isCg: boolean }` | `AttachmentDTO`（标记 / 取消 CG） |

上传时转为 WebP，等比缩到最大边 2048 像素，不放大小图，保存到 `data/assets/attachments/<id>.webp`。
原始宽高持久化在同目录 `<id>.json`；附件 id 不随尺寸变化。
文件缺失或无法解码返回本地化错误；超过大小上限返回 400 `TOO_LARGE`，无法识别的图片返回 400 `BAD_IMAGE`。

`POST /chats/:id/generate` 的 send 模式支持 `{ mode: 'send', text: '', images: ['附件id'] }`，
最多附加 10 张，允许只有图片。所有 id 必须存在，否则返回 400 `BAD_ATTACHMENT` 且不保存用户消息。
用户消息 `meta.images` 保存完整的 `AttachmentDTO[]`，刷新或分支后仍可显示。

生成预设 `samplers.inlineImages` 开启后，从最新消息往前保留 `imageLimit` 张图片（0 不限），
更早的图片及关闭发送图片时的全部图片逐张转换为文字占位；有 caption 时可使用图片说明，caption 扩展的 alwaysText 可强制使用文字。每张实际发送图片按 300 token 估算预算，
带图片的历史消息保留后处理边界。发送前按 `imageMaxSize` 等比缩小，按「id + 尺寸」缓存最近 50 项；
转换为 OpenAI `content: [text, image_url, ...]`，`image_url.detail` 使用 `imageDetail`（auto / low / high）。
请求日志保留多模态结构，但 data URL 替换为 `[图片 <id>]`。

## 背景 `/backgrounds`

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| GET | `/backgrounds?folderId=` | 查询背景库，可按文件夹筛选 | 可选 folderId | `BackgroundDTO[]` |
| POST | `/backgrounds` | 上传背景 | multipart `file`、可选 `name` | `BackgroundDTO` |
| POST | `/backgrounds/import-url` | 从网址导入背景 | `importBackgroundUrlInput`（url、name?） | `BackgroundDTO` |
| PATCH | `/backgrounds/:id` | 修改名称、描述或设为公共背景 | `UpdateBackgroundInput`（chatId 只允许 null） | `BackgroundDTO` |
| DELETE | `/backgrounds/:id` | 删除背景 | — | ok |
| POST | `/backgrounds/batch-delete` | 批量删除背景 | `batchDeleteBackgroundsInput`（ids，1–2000 个） | ok |
| POST | `/backgrounds/auto` | 让模型选背景并应用到会话 | `autoBackgroundInput`（chatId） | `{ background: BackgroundDTO, reply }` |
| GET | `/backgrounds/folders` | 获取文件夹 | — | `BackgroundFolderDTO[]` |
| POST | `/backgrounds/folders` | 新建文件夹 | `BackgroundFolderInput` | `BackgroundFolderDTO` |
| PATCH | `/backgrounds/folders/:id` | 修改文件夹 | `backgroundFolderInput.partial()` | `BackgroundFolderDTO` |
| DELETE | `/backgrounds/folders/:id` | 删除文件夹，保留背景 | — | ok |
| POST | `/backgrounds/folders/add` | 添加背景到文件夹 | `backgroundFolderItemsInput`（folderId、backgroundIds） | ok |
| POST | `/backgrounds/folders/remove` | 从文件夹移除背景 | 同上 | ok |
| GET | `/backgrounds/settings` | 获取全局背景 | — | `BackgroundSettings` |
| PUT | `/backgrounds/settings` | 设置全局背景 | `backgroundSettingsInput`（globalId 可为 null） | `BackgroundSettings` |

图片上限 20MB，视频上限 100MB；静态图转 WebP，动态背景支持 GIF / MP4 / WebM。
背景可属于多个文件夹；自动选择只使用公共背景和当前会话生成的背景。
会话自动换背景由 `UpdateChatInput.autoBackground` 控制（lore、everyN），默认关闭。

## 玩法预设 `/play-presets`

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| GET | `/play-presets` | 获取玩法预设列表 | — | `PlayPresetDTO[]` |
| POST | `/play-presets` | 创建玩法预设 | `PlayPresetInput` | `PlayPresetDTO` |
| GET | `/play-presets/:id` | 获取详情 | — | `PlayPresetDTO` |
| PATCH | `/play-presets/:id` | 更新玩法预设 | `Partial<PlayPresetInput>` | `PlayPresetDTO` |
| DELETE | `/play-presets/:id` | 删除玩法预设 | — | ok（不能删除最后一个） |
| POST | `/play-presets/:id/default` | 设为默认 | — | ok |
| POST | `/play-presets/:id/duplicate` | 复制玩法预设 | — | `PlayPresetDTO` |
| POST | `/play-presets/:id/reset` | 将内置预设恢复为内置默认值 | — | `PlayPresetDTO` |
| POST | `/play-presets/restore-builtins` | 补回已删除的内置预设 | — | `{ restored: number }` |
| POST | `/play-presets/import` | 导入玩法预设 JSON | multipart `file` | `PlayPresetDTO` |
| GET | `/play-presets/:id/export` | 导出玩法预设 | — | JSON 文件下载 |

## 立绘 `/characters/:id/sprites`

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| GET | `/characters/:id/sprites` | 获取角色全部立绘 | — | `SpriteDTO[]` |
| POST | `/characters/:id/sprites` | 批量上传图片 | multipart `files`（可重复）、outfit?、expression?，单张上限 20MB | `SpriteImportResult` |
| POST | `/characters/:id/sprites/import` | 导入立绘压缩包 | multipart `file`（ZIP，上限 300MB）、outfit?（根目录图片的服装） | `SpriteImportResult` |
| PATCH | `/characters/:id/sprites/:spriteId` | 修改表情或服装 | `UpdateSpriteInput` | `SpriteDTO` |
| DELETE | `/characters/:id/sprites/:spriteId` | 删除一张立绘 | — | ok |
| POST | `/characters/:id/sprites/delete` | 批量删除立绘 | `{ ids }`（1–500 个） | `{ deleted: number }` |
| DELETE | `/characters/:id/sprites?outfit=` | 删除整套服装 | outfit 必填，空串为默认服装 | `{ deleted: number }` |
| POST | `/characters/:id/sprites/generate` | 启动批量生成任务 | `GenerateSpritesInput`（outfit、expressions、basePrompt?） | `{ jobId }` |
| GET | `/characters/:id/sprites/generate/:jobId` | 查询任务进度 | — | `SpriteJobDTO`（total、done、failed、status） |

同一角色已有生成任务时返回 409 `SPRITE_BUSY`；任务保存在内存中，重启后不可查询。

## 回收站 `/trash`

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| GET | `/trash` | 列出删除的角色和群组 | — | `TrashDTO` |
| POST | `/trash/characters/:id/restore` | 恢复角色及会话 | — | ok |
| POST | `/trash/groups/:id/restore` | 恢复群组及会话 | — | ok |
| DELETE | `/trash/characters/:id` | 彻底删除角色及关联数据 | — | ok |
| DELETE | `/trash/groups/:id` | 彻底删除群组及关联数据 | — | ok |
| DELETE | `/trash` | 清空回收站 | — | `{ deleted: number }` |

## 连接配置组 `/profiles`

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| GET | `/profiles` | 获取配置组列表 | — | `ProfileDTO[]` |
| POST | `/profiles` | 新建配置组 | `ProfileInput` | `ProfileDTO` |
| PUT | `/profiles/:id` | 整体更新配置组 | `ProfileInput` | `ProfileDTO` |
| PUT | `/profiles/default` | 设置 / 清除全局默认配置组 | `{ id: string \| null }` | ok |
| DELETE | `/profiles/:id` | 删除配置组 | — | ok |

`ProfileInput` 可绑定文本连接、生成预设、模型、正则规则、图片连接和提示词连接。
实际生效结果通过 `GET /chats/:id/profile` 查询。

## 快速回复 `/quick-replies`

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| GET | `/quick-replies` | 获取回复集和全局启用项 | — | `QuickReplyState` |
| POST | `/quick-replies` | 创建回复集 | `QuickReplySetInput` | `QuickReplySet` |
| PUT | `/quick-replies/:id` | 整体更新回复集 | `QuickReplySetInput` | `QuickReplySet` |
| PUT | `/quick-replies/global` | 设置全局启用的回复集 | `{ setIds: string[] }` | `QuickReplyState` |
| DELETE | `/quick-replies/:id` | 删除回复集 | — | ok |

## 应用设置 `/app-settings`

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| GET | `/app-settings` | 获取应用设置 | — | `AppSettings` |
| PUT | `/app-settings` | 保存应用设置 | `appSettingsSchema`（language 为 zh / en） | `AppSettings` |

语言影响界面、后端用户提示和没有对话上下文时模型的输出语言。

## 静态资源 `/assets`

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| GET | `/assets/avatars/:file` | 获取头像 | `ULID.png` / `ULID.webp` | 图片文件 |
| GET | `/assets/attachments/:file` | 获取聊天附件 | `ULID.webp` | WebP 图片 |
| GET | `/assets/backgrounds/:file` | 获取背景或缩略图 | `ULID.webp/gif/mp4/webm` 或 `ULID.thumb.webp` | 图片 / 视频；视频支持单段 Range（206 / 416） |
| GET | `/assets/sprites/:characterId/:file` | 获取立绘或缩略图 | ULID 角色 id；`ULID.png/webp/gif/jpg` 或 `ULID.thumb.webp` | 图片文件 |

资源长期缓存（`public, max-age=31536000, immutable`）；文件名非法返回 400，文件不存在返回 404。

## 健康检查 `/health`

| 方法 | 路径 | 说明 | 请求 | 返回 |
| --- | --- | --- | --- | --- |
| GET | `/health` | 检查服务可用性 | — | `{ ok: true }` |


### VN5：属性卡、选项检定与战斗

- 角色创建 / 更新 / 详情的 `sheet` 为 `CharacterSheet | null`，与其他 extras 一起提供；存入现有 `extensions.nobot.sheet`，角色卡 JSON / PNG 导入导出均使用 `data.extensions.nobot.sheet`。同命名空间的其他字段保持原样。
- 人设创建 / 更新 / 列表返回 `sheet: CharacterSheet | null`，省略时默认 `null`；PATCH 省略字段不改变旧值，传 `null` 清除。
- `POST /api/chats/:id/check`：body 为 `{ skill: string, dc: integer (0–100), who?: string, advantage?: "advantage" | "disadvantage" }`；返回 `CheckResult`，不写消息或其他数据库状态。舞台指令未启用或规则系统未实现时返回 `400 TRPG_DISABLED`。
- `POST /api/chats/:id/generate` 的 `send` body 支持可选 `check: CheckResult`，完整校验后存入用户消息 `meta.check`。生成 Prompt 时在正文末尾追加英文检定说明；数据库正文不变。此扩展在 server 入口校验，shared 的 `generateInput` 暂未包含 `check`。
- `who` 默认玩家：`player`、当前人设名、`me` / `myself` / `user` / `我` / `玩家` 指向玩家；会话成员按完整名字（忽略大小写）优先，再匹配名字第一个词；否则作为 NPC 从 vars 只读。玩家变量固定使用 `player.*`，队友使用完整角色名。
- 初始变量优先级：schema init < sheet `initVars` < 世界书 InitVar < 消息路径 varsPatch / varsManual。仅启用舞台指令且规则系统已实现时加载属性卡。
- `roll_dice` 工具支持 `reason`，结果保存于工具消息 `meta.dice`；`ability_check(who?, skill, dc?, advantage?)` 使用会话规则和 `critRules`，结果保存于 `meta.check`。不支持规则时，会话工具列表不提供 `ability_check`。
- `<combat start: player, Ellie, Goblin>` 入库时掷先攻并写入操作的 `order`；`<combat next>` / `<combat end>` 推进 / 结束战斗。聊天详情与舞台接口返回 `StageState.combat`；回放、切分支和续写复用已保存先攻，重新生成的新操作独立掷骰。
