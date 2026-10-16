# 后端接口约定

所有接口以 `/api` 开头，请求和返回都是 JSON（上传文件用 multipart，字段名 `file`）。
类型名都来自 `packages/shared`。出错时返回 `{ error: { code, message } }`，`message` 是给用户看的中文。

通用约定：

- 列表接口返回数组，按 `updatedAt` 倒序（连接、预设、人设按创建顺序）
- `PATCH` 只更新传了的字段
- 删除成功返回 `{ ok: true }`
- 找不到资源返回 404，`code` 为 `NOT_FOUND`
- 「默认」的概念统一存在 settings 表（键见 `services/settings.ts` 的 `SETTING_KEYS`）

## 连接 `/connections`（已实现）

| 方法 | 路径 | 请求 | 返回 |
| --- | --- | --- | --- |
| GET | `/connections` | — | `ApiPresetDTO[]` |
| POST | `/connections` | `ApiPresetInput` | `ApiPresetDTO` |
| PATCH | `/connections/:id` | `ApiPresetInput` | `ApiPresetDTO` |
| DELETE | `/connections/:id` | — | ok |
| POST | `/connections/:id/default` | — | ok |
| POST | `/connections/test` | `TestConnectionInput` | `TestConnectionResult` |

## 生成预设 `/presets`

| 方法 | 路径 | 请求 | 返回 |
| --- | --- | --- | --- |
| GET | `/presets` | — | `PromptPresetDTO[]` |
| GET | `/presets/:id` | — | `PromptPresetDTO` |
| POST | `/presets` | `PromptPresetInput` | `PromptPresetDTO` |
| PATCH | `/presets/:id` | `{ name?, data? }`（data 是完整的 PresetData） | `PromptPresetDTO` |
| DELETE | `/presets/:id` | — | ok（不能删最后一个，返回 400 `LAST_PRESET`） |
| POST | `/presets/:id/default` | — | ok |
| POST | `/presets/:id/duplicate` | — | `PromptPresetDTO`（名字加「 副本」） |
| POST | `/presets/import` | multipart `file`（酒馆预设 JSON） | `PromptPresetDTO`（名字取文件名去掉扩展名） |
| GET | `/presets/:id/export` | — | 酒馆格式 JSON，`Content-Disposition: attachment; filename*=UTF-8''<名字>.json` |

- 数据库存的 data 读出来时一律经 `presetDataSchema.parse` 补齐默认值
- 删除默认预设后，把剩下的第一个设为默认

## 人设 `/personas`

| 方法 | 路径 | 请求 | 返回 |
| --- | --- | --- | --- |
| GET | `/personas` | — | `PersonaDTO[]` |
| POST | `/personas` | `PersonaInput` | `PersonaDTO` |
| PATCH | `/personas/:id` | `PersonaUpdateInput` | `PersonaDTO` |
| DELETE | `/personas/:id` | — | ok（不能删最后一个，返回 400 `LAST_PERSONA`；删的是默认人设时把第一个设为默认） |
| POST | `/personas/:id/default` | — | ok |
| POST | `/personas/:id/avatar` | multipart `file`（任意图片） | `PersonaDTO` |
| DELETE | `/personas/:id/avatar` | — | `PersonaDTO` |

头像用 `lib/files.ts` 的 `saveAvatar` / `deleteAvatar` / `avatarUrl`。

## 角色 `/characters`

| 方法 | 路径 | 请求 | 返回 |
| --- | --- | --- | --- |
| GET | `/characters` | — | `CharacterSummary[]` |
| GET | `/characters/:id` | — | `CharacterDTO` |
| POST | `/characters` | `CharacterInput`（新建空白角色） | `CharacterDTO` |
| POST | `/characters/import/preview` | multipart `file`（PNG / JSON 角色卡） | `CharacterImportPreview`（只解析，不保存角色、世界书或头像） |
| POST | `/characters/import?lorebook=link\|import\|skip` | multipart `file`（PNG / JSON 角色卡），query 缺省 `skip` | `CharacterDTO` |
| PATCH | `/characters/:id` | `CharacterUpdateInput` | `CharacterDTO` |
| DELETE | `/characters/:id` | — | ok（同时删头像文件；会话靠外键级联删除） |
| POST | `/characters/:id/duplicate` | — | `CharacterDTO`（名字加「 副本」，复制头像和世界书关联） |
| POST | `/characters/:id/avatar` | multipart `file`（任意图片） | `CharacterDTO` |
| GET | `/characters/:id/export?format=png\|json` | — | 文件下载 |

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

| 方法 | 路径 | 请求 | 返回 |
| --- | --- | --- | --- |
| GET | `/lorebooks` | — | `LorebookDTO[]` |
| POST | `/lorebooks` | `LorebookInput` | `LorebookDTO` |
| GET | `/lorebooks/:id` | — | `{ lorebook: LorebookDTO, entries: LorebookEntryDTO[] }`（entries 按 sort 升序） |
| PATCH | `/lorebooks/:id` | `Partial<LorebookInput>` | `LorebookDTO` |
| DELETE | `/lorebooks/:id` | — | ok |
| POST | `/lorebooks/import` | multipart `file`（酒馆世界书 JSON 或角色卡内嵌格式） | `LorebookDTO`（名字取 json.name，没有则文件名） |
| GET | `/lorebooks/:id/export` | — | 酒馆世界书 JSON 文件下载 |
| POST | `/lorebooks/:id/entries` | `Partial<LorebookEntryData>` | `LorebookEntryDTO`（追加到末尾） |
| PATCH | `/lorebooks/entries/:entryId` | `Partial<LorebookEntryData>` | `LorebookEntryDTO` |
| DELETE | `/lorebooks/entries/:entryId` | — | ok |
| POST | `/lorebooks/:id/entries/reorder` | `{ ids: string[] }` | ok |
| GET | `/lorebooks/settings` | — | `WorldInfoSettings` |
| PUT | `/lorebooks/settings` | `WorldInfoSettings` | `WorldInfoSettings` |

注意 `/lorebooks/settings`、`/lorebooks/import`、`/lorebooks/entries/...` 要注册在 `/:id` 之前。
全局设置用 `services/settings.ts` 的 `getWorldInfoSettings` / `setWorldInfoSettings`。

## 群组 `/groups`

| 方法 | 路径 | 请求 | 返回 |
| --- | --- | --- | --- |
| GET | `/groups` | — | `GroupDTO[]` |
| GET | `/groups/:id` | — | `GroupDTO` |
| POST | `/groups` | `GroupInput` | `GroupDTO` |
| PATCH | `/groups/:id` | `Partial<GroupInput>`（members 传了就整体替换） | `GroupDTO` |
| DELETE | `/groups/:id` | — | ok（群聊会话靠外键级联删除） |

## 会话 `/chats`（架构师实现）

| 方法 | 路径 | 请求 | 返回 |
| --- | --- | --- | --- |
| GET | `/chats?characterId=&groupId=` | — | `ChatSummary[]` |
| POST | `/chats` | `CreateChatInput` | `ChatDTO` |
| GET | `/chats/:id?before=&limit=` | — | `ChatPage` |
| PATCH | `/chats/:id` | `UpdateChatInput` | `ChatDTO` |
| DELETE | `/chats/:id` | — | ok |
| POST | `/chats/:id/swipe` | `SwipeInput` | `{ leafId }` |
| POST | `/chats/:id/branch` | `{ messageId }` | `ChatDTO`（新会话） |
| POST | `/chats/:id/prompt-preview` | `{ type?, text? }` | `PromptPreview` |
| POST | `/chats/:id/generate` | `GenerateInput` | SSE：`GenerateEvent` |
| GET | `/chats/:id/stream` | — | SSE：重新接上进行中的生成 |
| POST | `/chats/:id/abort` | — | ok |
| POST | `/chats/:id/impersonate` | — | SSE：`ImpersonateEvent` |

## 消息、日志、扩展（架构师实现）

| 方法 | 路径 | 请求 | 返回 |
| --- | --- | --- | --- |
| PATCH | `/messages/:id` | `{ content }` | `MessageDTO` |
| DELETE | `/messages/:id` | — | ok |
| GET | `/logs?chatId=&limit=` | — | `GenerationLogSummary[]` |
| GET | `/logs/:id` | — | `GenerationLogDTO` |
| DELETE | `/logs` | — | ok |
| GET | `/extensions` | — | `ExtensionDTO[]` |
| PATCH | `/extensions/:id` | `{ enabled?, settings? }` | `ExtensionDTO` |
| GET | `/extensions/tools` | — | `ToolInfo[]` |

## 扩展 v2

扩展列表的 `ExtensionDTO` 还包含：`author`（未提供时为空字符串）、
`client: { script, style }`（是否声明前端脚本和样式）、`hasRoutes`（是否提供自定义接口）。
内置扩展在前，本地扩展按目录名排序；加载失败的目录仍显示在列表中，包含 `loadError` 且不可启用。
`PATCH /extensions/:id` 的 settings 整体替换用户配置，读取时与扩展默认设置浅合并。停用不删除设置和扩展存储。

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| GET | `/extensions/:id/client.js` | manifest.client 指定的唯一文件，`Content-Type: text/javascript` |
| GET | `/extensions/:id/style.css` | manifest.style 指定的唯一文件，`Content-Type: text/css` |
| 任意 | `/ext/:id/*` | 转发给该扩展的 Hono 子应用，去掉 `/api/ext/:id` 前缀，保留查询与请求体 |

前端资源设置 `Cache-Control: no-cache`；扩展停用、不存在、未声明资源或文件不可用返回 404。
资源接口没有任意路径参数，manifest 文件路径不得越过扩展目录（包括软链接）。
扩展未启用或未提供自定义接口时 `/ext/:id/*` 返回 404。错误统一使用 `{ error: { code, message } }`。
routes 在加载扩展时注册一次，ctx.settings 每次读取返回当前合并配置，ctx.storage 使用 settings 表中的
`extdata:<扩展id>:<key>` 命名空间。

生成流程异步广播 `message:saved`（用户插入、助手最终保存、工具插入）和 `generation:complete`（任务 finally）；
创建会话后广播 `chat:created`。只有启用扩展接收事件，处理异常只记录日志。
详细契约、插槽、前端事件及安装示例见 [扩展开发文档](../../docs/extensions.md)。

## 图片附件 `/attachments`

| 方法 | 路径 | 请求 | 返回 |
| --- | --- | --- | --- |
| POST | `/attachments` | multipart `file`，常见位图格式，单文件最多 10MB | `AttachmentDTO`（id、url、原始 width / height） |
| GET | `/assets/attachments/:file` | 文件名必须为 `ULID.webp` | WebP 图片，长期缓存 |

上传时转为 WebP，等比缩到最大边 2048 像素，不放大小图，保存到 `data/assets/attachments/<id>.webp`。
原始宽高持久化在同目录 `<id>.json`；附件 id 不随尺寸变化。
文件缺失或无法解码返回中文错误；超过大小上限返回 400 `TOO_LARGE`，无法识别的图片返回 400 `BAD_IMAGE`。

`POST /chats/:id/generate` 的 send 模式支持 `{ mode: 'send', text: '', images: ['附件id'] }`，
最多附加 10 张，允许只有图片。所有 id 必须存在，否则返回 400 `BAD_ATTACHMENT` 且不保存用户消息。
用户消息 `meta.images` 保存完整的 `AttachmentDTO[]`，刷新或分支后仍可显示。

生成预设 `samplers.inlineImages` 开启后，从最新消息往前保留 `imageLimit` 张图片（0 不限），
更早的图片及关闭发送图片时的全部图片逐张转换为 `[图片]`。每张实际发送图片按 300 token 估算预算，
带图片的历史消息保留后处理边界。发送前按 `imageMaxSize` 等比缩小，按「id + 尺寸」缓存最近 50 项；
转换为 OpenAI `content: [text, image_url, ...]`，`image_url.detail` 使用 `imageDetail`（auto / low / high）。
请求日志保留多模态结构，但 data URL 替换为 `[图片 <id>]`。
