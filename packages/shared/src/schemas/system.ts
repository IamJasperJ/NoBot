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
/** 设置项的公共属性 */
interface SettingFieldBase {
  key: string
  label: string
  hint?: string
  /** 只在另一个设置项等于某个值（或其中之一）时显示，比如只在「后端」选 comfy 时显示 ComfyUI 的设置 */
  visibleWhen?: { key: string; equals: string | number | boolean | (string | number | boolean)[] }
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
   * optionsSource：候选项从扩展自己的接口拉取（GET /api/ext/<扩展 id>/<optionsSource>，返回 { options: { value, label }[] }），
   * 输入框旁边显示下拉候选和「拉取」按钮，仍然可以手动输入（比如模型名）。拉取时把当前表单里的设置作为查询参数 settings（JSON）带上，
   * 这样不用先保存就能用刚填的地址和密钥拉取
   */
  | (SettingFieldBase & { type: 'string'; secret?: boolean; placeholder?: string; optionsSource?: string })
  | (SettingFieldBase & { type: 'textarea'; rows?: number; placeholder?: string })
  | (SettingFieldBase & { type: 'number'; min?: number; max?: number; step?: number })
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
   * 分组标题，不对应任何设置值。从这个标题到下一个标题之间的字段属于这一组，组可以展开 / 收起。
   * defaultCollapsed：默认收起（不常用的高级分组，比如提示词模板、ComfyUI 高级）
   */
  | (SettingFieldBase & { type: 'heading'; defaultCollapsed?: boolean })

export interface ExtensionDTO {
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
}

/** 工具（function calling）的说明，展示用 */
export interface ToolInfo {
  name: string
  description: string
  /** 来自哪个扩展，内置工具为 builtin */
  source: string
}
