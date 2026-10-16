import type { MessageDTO } from '@ai-parter/shared'
import type { QueryClient } from '@tanstack/react-query'
import type * as ReactNS from 'react'
import type { ReactNode } from 'react'
import type { api } from '../api/client'
import type { View } from '../stores/ui'

/**
 * 前端扩展的接口。扩展的前端部分是一个浏览器直接加载的 ES 模块（不经过打包），默认导出：
 *
 *   export default function activate(api) {
 *     const h = api.React.createElement
 *     api.registerSlot('chat.header.actions', { id: 'hello', render: ({ chatId }) => h('button', { onClick: () => api.toast.info(chatId) }, '你好') })
 *     return () => {}   // 可选：停用时调用的清理函数
 *   }
 *
 * 扩展拿不到 import 'react'（没有打包），所以 React、查询客户端等都通过 api 传进去，
 * 写界面用 api.React.createElement（或者自己用 htm 这类库在扩展里打包好）。
 */

/** 界面上的扩展插槽，以及每个插槽渲染时收到的参数 */
export interface SlotProps {
  /** 聊天页标题栏右侧（会话设置、预览按钮旁边） */
  'chat.header.actions': { chatId: string }
  /** 输入框左边「+」菜单里的条目 */
  'chat.composer.menu': { chatId: string; setText: (text: string) => void; close: () => void }
  /** 每条消息的「⋯」菜单里的条目 */
  'chat.message.actions': { chatId: string; message: MessageDTO }
  /** 每条消息正文下方 */
  'chat.message.footer': { chatId: string; message: MessageDTO }
  /** 聊天页侧栏底部 */
  'sidebar.footer': Record<string, never>
}
export type SlotName = keyof SlotProps

export interface SlotContribution<K extends SlotName> {
  /** 在同一个插槽里唯一 */
  id: string
  render: (props: SlotProps[K]) => ReactNode
  /** 越小越靠前，默认 100 */
  order?: number
}

/** 扩展注册的独立页面：出现在左侧导航里 */
export interface PageContribution {
  /** 在扩展内唯一；页面的 view 名是 ext:<扩展 id>:<id> */
  id: string
  label: string
  /** 导航里显示的图标：一个 emoji 或一两个字 */
  icon: string
  render: () => ReactNode
}

/** 前端事件：扩展可以订阅 */
export type ClientEvent =
  | { type: 'chat:open'; chatId: string | null }
  | { type: 'generation:start'; chatId: string }
  | { type: 'generation:complete'; chatId: string }
  | { type: 'message:sent'; chatId: string; text: string }

export interface ClientExtensionAPI {
  /** 扩展 id */
  id: string
  /** 和应用共用的 React 实例 */
  React: typeof ReactNS
  /** 后端接口客户端（和应用自己用的是同一个） */
  api: typeof api
  /** TanStack Query 客户端：改了数据后可以 invalidateQueries 刷新界面 */
  queryClient: QueryClient
  toast: { info: (message: string) => void; error: (message: string) => void }
  /** 切换页面；扩展页面的 view 是 `ext:<扩展 id>:<页面 id>` */
  openView: (view: View | `ext:${string}`, focusId?: string | null) => void
  /** 当前打开的会话 id */
  getChatId: () => string | null
  /** 这个扩展的设置（和扩展页里编辑的是同一份） */
  getSettings: () => Promise<Record<string, unknown>>
  saveSettings: (settings: Record<string, unknown>) => Promise<void>
  /** 调用这个扩展自己的后端接口：path 相对 /api/ext/<id>/ */
  fetchServer: (path: string, init?: RequestInit) => Promise<Response>
  registerSlot: <K extends SlotName>(slot: K, contribution: SlotContribution<K>) => void
  registerPage: (page: PageContribution) => void
  /**
   * 改变消息的显示（不改保存的内容），比如把特定标记渲染成别的文字。
   * 多个扩展的变换按加载顺序依次执行。
   */
  registerMessageTransform: (fn: (text: string, message: MessageDTO) => string) => void
  /** 订阅前端事件，返回取消订阅的函数 */
  on: <T extends ClientEvent['type']>(type: T, handler: (e: Extract<ClientEvent, { type: T }>) => void) => () => void
}

/** client.js 的默认导出 */
export type ActivateFn = (api: ClientExtensionAPI) => void | (() => void) | Promise<undefined | (() => void)>
