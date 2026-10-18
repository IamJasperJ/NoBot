import { z } from 'zod'
import type { CommandDescription } from './quickReply'
/**
 * 日志、扩展这类「系统」功能的类型。
 */

/** 一次模型请求的日志（错误查看用） */
export interface GenerationLogSummary {
  id: string
  chatId: string | null
  messageId: string | null
  /** generation：生成；impersonate：代写；test：测试连接；error：服务器内部错误 */
  /** extension：扩展发起的模型请求（如图片生成扩展让模型写提示词）；image：图片接口请求 */
  kind: 'generation' | 'impersonate' | 'test' | 'error' | 'extension' | 'image'
  status: 'ok' | 'error' | 'aborted'
  model: string | null
  durationMs: number | null
  /** 错误信息或简短说明 */
  summary: string
  createdAt: number
}

export interface GenerationLogDTO extends GenerationLogSummary {
  /** 发给模型的完整请求体（不含 API Key） */
  request: unknown
  /** 模型返回的结果摘要：内容、用量、finish_reason、工具调用 */
  response: unknown
  /** 组装报告，用来查看每段 Prompt 的来源 */
  report: unknown
}

/** 扩展设置表单的字段描述，前端按它自动生成表单 */
/**
 * 显示条件：另一个设置项等于某个值（或其中之一）。
 * 写成数组时表示「同时满足」，比如「后端是 OpenAI 且复用连接选了自定义」
 */
export interface VisibleCondition {
  key: string
  equals: string | number | boolean | (string | number | boolean)[]
}

/** 设置项的公共属性 */
interface SettingFieldBase {
  key: string
  label: string
  hint?: string
  /** 只在另一个设置项等于某个值（或其中之一）时显示，比如只在「后端」选 comfy 时显示 ComfyUI 的设置 */
  visibleWhen?: VisibleCondition | VisibleCondition[]
  /**
   * 附着到另一个设置项：不单独占一行，而是在 attachTo 那个字段输入框的右边显示一个小按钮（文字是 attachLabel，通常一个字，比如「头」），
   * 点开弹出小窗编辑这个字段。已经填了值时按钮高亮。适合不常改的附属设置（比如地址的附加请求头）
   */
  attachTo?: string
  attachLabel?: string
}

export type ExtensionSettingField =
  | (SettingFieldBase & { type: 'boolean' })
  /** secret：密钥类字段，输入框用密码样式 */
  /**
   * secret：密钥类字段，输入框用密码样式。
   * optionsSource：候选项从扩展自己的接口拉取：POST /api/ext/<扩展 id>/<optionsSource>，
   * 请求体 { settings: 当前表单里的设置（草稿，未保存）, chatId?: 当前会话 }，返回 { options: { value, label }[] }。
   * 用 POST 是因为草稿里可能有很长的内容（比如整份 ComfyUI 工作流），放进网址会超长。
   * 输入框旁边显示可输入的下拉候选和「拉取」按钮，仍然可以手动输入（比如模型名）
   */
  | (SettingFieldBase & { type: 'string'; secret?: boolean; placeholder?: string; optionsSource?: string })
  | (SettingFieldBase & { type: 'textarea'; rows?: number; placeholder?: string })
  /** slider：同时显示滑块（需要 min 和 max），适合步数、CFG 这类有明确范围的值 */
  | (SettingFieldBase & { type: 'number'; min?: number; max?: number; step?: number; slider?: boolean })
  /** optionsSource：同 string，候选项从接口拉取，和 options 合并（options 在前） */
  | (SettingFieldBase & { type: 'select'; options: { value: string; label: string }[]; optionsSource?: string })
  | (SettingFieldBase & {
      type: 'list'
      /** 列表里每一项的字段 */
      itemFields: ExtensionSettingField[]
      /**
       * 每一项折叠时显示的标题取自哪个字段（默认用第一个 string 字段）。
       * 列表项默认折叠成一行标题，点击展开编辑；新添加的项自动展开
       */
      titleKey?: string
    })
  /**
   * 自定义控件：由扩展的前端自己渲染（注册 'extensions.settings.field' 插槽，id 等于这个字段的 key）。
   * 用于表单组件表达不了的交互，比如「工作流下拉 + 编辑 / 新建 / 重命名 / 删除」「风格下拉 + 保存 / 重命名 / 删除」。
   * 前端没有注册对应控件时显示一行提示，不影响其他设置
   */
  | (SettingFieldBase & { type: 'custom' })
  /**
   * 分组标题，不对应任何设置值。从这个标题到下一个标题之间的字段属于这一组，组可以展开 / 收起。
   * defaultCollapsed：默认收起（不常用的高级分组，比如提示词模板、ComfyUI 高级）
   */
  | (SettingFieldBase & { type: 'heading'; defaultCollapsed?: boolean })

export interface ExtensionDTO {
  commands?: CommandDescription[]
  id: string
  name: string
  description: string
  version: string
  /** builtin：随应用自带；local：data/extensions 下的第三方扩展 */
  source: 'builtin' | 'local'
  enabled: boolean
  /** 扩展提供的能力，用于展示 */
  provides: { macros: string[]; tools: string[]; hooks: string[] }
  settingsSchema: ExtensionSettingField[]
  settings: Record<string, unknown>
  /** 作者（来自 manifest.json） */
  author: string
  /**
   * 前端部分：script 为 true 时浏览器会加载 /api/extensions/<id>/client.js 并调用它的 activate；
   * style 为 true 时加载 /api/extensions/<id>/style.css
   */
  client: { script: boolean; style: boolean }
  /** 后端部分注册了自定义接口时，接口前缀是 /api/ext/<id>/ */
  hasRoutes: boolean
  /** 加载失败时的错误 */
  loadError?: string
  /**
   * manifest 声明的权限；null 表示没有声明（旧扩展），此时按检测到的能力请用户确认，并给出警告。
   * 内置扩展等于检测到的能力
   */
  permissions: ExtensionPermissions | null
  /** 实际加载后检测到的能力（network 检测不到，不在这里） */
  detected: Omit<ExtensionPermissions, 'network'>
  /** 声明和实际不符等警告（已翻译成界面语言） */
  permissionWarnings: string[]
  /** 需要用户确认权限后才能启用：首次安装、没确认过，或者更新后权限变多了 */
  needsApproval: boolean
  /** 通过 Git 安装的扩展的仓库信息；手动放进目录的、内置的为 null */
  git: ExtensionGitInfo | null
  /** 代码版本标识（Git 提交或文件修改时间），前端热重载 client.js / style.css 时拼进地址绕过缓存 */
  revision: string
}

/** G4：扩展在 manifest.permissions 里声明自己会用到的能力，安装和启用时给用户确认 */
export interface ExtensionPermissions {
  /** 运行后端代码（manifest.server） */
  server: boolean
  /** 在浏览器里运行前端脚本（manifest.client）或注入样式 */
  client: boolean
  /** 注册自定义接口 /api/ext/<id>/... */
  routes: boolean
  /** 提供给模型调用的工具 */
  tools: boolean
  /** 介入提示词组装、输入输出改写等钩子 */
  hooks: boolean
  /** 会访问的外部域名，仅声明，做不到强制 */
  network: string[]
}

export const extensionPermissionsSchema = z.object({
  server: z.boolean().default(false),
  client: z.boolean().default(false),
  routes: z.boolean().default(false),
  tools: z.boolean().default(false),
  hooks: z.boolean().default(false),
  network: z.array(z.string().trim().min(1)).default([]),
})

export interface ExtensionGitInfo {
  url: string
  /** 当前分支或标签；分离头指针时为提交号 */
  ref: string
  commit: string
  /** 最近一次检查更新时远端的提交；没检查过为 null */
  remoteCommit: string | null
  /** 有没有更新；没检查过为 null */
  hasUpdate: boolean | null
  checkedAt: number | null
}

/** 服务器上的 Git 可用性（安装功能的前提） */
export interface GitStatusDTO {
  available: boolean
  version?: string
}

export const extensionInstallInput = z.object({
  /** 只接受 https:// 或 git@host:path 形式 */
  url: z.string().trim().min(1),
  /** 分支或标签，留空用默认分支 */
  ref: z.string().trim().default(''),
})
export type ExtensionInstallInput = z.input<typeof extensionInstallInput>

/** 安装第一步：克隆到暂存目录后返回预览，由用户确认权限后再真正安装 */
export interface ExtensionInstallPreview {
  /** 暂存标识，确认或取消时带上；一段时间不确认会被清理 */
  token: string
  manifest: { id: string; name: string; version: string; description: string; author: string }
  permissions: ExtensionPermissions | null
  /** 从仓库文件静态推断出的能力（有没有 server / client 入口），只能推断这两项 */
  detected: Pick<ExtensionPermissions, 'server' | 'client'>
  warnings: string[]
  ref: string
  commit: string
  /** 同 id 的扩展已经安装过（确认后会被覆盖） */
  exists: boolean
}

export const extensionInstallConfirmInput = z.object({
  token: z.string().min(1),
  /** 同时确认权限并启用 */
  enable: z.boolean().default(false),
})

export interface ExtensionUpdateResult {
  extension: ExtensionDTO
  /** 更新后权限变多：扩展已被停用，等待重新确认 */
  permissionsChanged: boolean
}

/** 扩展目录（类似酒馆的 Download Extensions）：一个公开的 JSON 索引，列出可安装的扩展 */
export interface ExtensionCatalogItem {
  id: string
  name: string
  description: string
  author: string
  /** Git 仓库地址 */
  repo: string
  ref?: string
  version?: string
  tags: string[]
  permissions?: ExtensionPermissions
  /** 由服务器补上：是否已安装、已装版本 */
  installed: boolean
  installedVersion?: string
}

export interface ExtensionCatalogDTO {
  sources: { url: string; ok: boolean; error?: string; items: ExtensionCatalogItem[] }[]
}

export const extensionCatalogSourcesInput = z.object({ urls: z.array(z.url()).max(20) })

/** 工具（function calling）的说明，展示用 */
export interface ToolInfo {
  name: string
  description: string
  /** 来自哪个扩展，内置工具为 builtin */
  source: string
}

/** 界面语言（也决定后端返回给用户看的文字、以及没有对话上下文时模型的输出语言） */
export const languageSchema = z.enum(['zh', 'en'])
export type Language = z.infer<typeof languageSchema>

/** 应用级的全局设置：GET / PUT /api/app-settings */
export const appSettingsSchema = z.object({ language: languageSchema })
export type AppSettings = z.infer<typeof appSettingsSchema>
