/**
 * 日志、扩展这类「系统」功能的类型。
 */

/** 一次模型请求的日志（错误查看用） */
export interface GenerationLogSummary {
  id: string
  chatId: string | null
  messageId: string | null
  /** generation：生成；impersonate：代写；test：测试连接；error：服务器内部错误 */
  kind: 'generation' | 'impersonate' | 'test' | 'error'
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
export type ExtensionSettingField =
  | { key: string; label: string; type: 'boolean'; hint?: string }
  | { key: string; label: string; type: 'string' | 'textarea'; hint?: string }
  | { key: string; label: string; type: 'number'; min?: number; max?: number; hint?: string }
  | { key: string; label: string; type: 'select'; options: { value: string; label: string }[]; hint?: string }
  | {
      key: string
      label: string
      type: 'list'
      hint?: string
      /** 列表里每一项的字段 */
      itemFields: ExtensionSettingField[]
    }

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
