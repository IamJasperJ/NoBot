import type { Beat, CharacterDTO, MessageDTO, PlayPresetData, StageState } from '@nobot/shared'
import type { QueryClient } from '@tanstack/react-query'
import type * as ReactNS from 'react'
import type { ReactNode } from 'react'
import type { api } from '../api/client'
import type { SlashCommand } from '../commands/registry'
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
  /** VN 不可见层，用于驱动音频等效果。 */
  'vn.layer': {
    chatId: string
    stage: StageState
    /** 当前消息全部拍，序号与 beatIndex 对应。 */
    beats: Beat[]
    beatIndex: number | undefined
    /** 当前消息与备选共同组成的演出标识。 */
    playKey: string | null
    play: PlayPresetData
    /** 快进或回看时不播放音效。 */
    skipping: boolean
  }
  /** VN 顶部工具栏按钮区。 */
  'vn.toolbar': { chatId: string; play: PlayPresetData }

  'character.editor.sections': {
    character: CharacterDTO
    save: (patch: { extensions: Record<string, unknown> }) => Promise<void>
  }
  /** 图片区域下方，所有角色（包括工具）均可注册媒体操作。 */
  'chat.message.media': { chatId: string; message: MessageDTO }
  /** 设置表单下方，仅渲染 extensionId 对应扩展自己的贡献；settings 是当前草稿。 */
  /**
   * 设置表单里 type 为 custom 的字段的控件。贡献的 id 必须等于字段的 key，只渲染 extensionId 匹配的扩展自己的贡献。
   * value / onChange 是这个字段的值；settings / onSettingsChange 是整份设置草稿（需要同时改多个字段时用，比如风格列表 + 当前风格）
   */
  'extensions.settings.field': {
    extensionId: string
    fieldKey: string
    label: string
    /** 设置项说明。控件自己决定怎么显示，推荐用 components/form 的 DenseRow（标签旁的 ⓘ） */
    hint?: string | undefined
    value: unknown
    onChange: (value: unknown) => void
    settings: Record<string, unknown>
    onSettingsChange: (settings: Record<string, unknown>) => void
    disabled: boolean
  }
  'extensions.settings.footer': {
    extensionId: string
    settings: Record<string, unknown>
    /** 扩展保存候选值时同步表单草稿，防止后续保存覆盖它。 */
    onSettingsChange?: (settings: Record<string, unknown>) => void
  }
  /** 会话级操作：聊天页没有顶部标题栏了，渲染在输入框「+」菜单里 */
  'chat.header.actions': { chatId: string }
  /** 输入框左侧、+ 按钮右边的按钮区 */
  'chat.composer.buttons': { chatId: string }
  /** 输入框左边「+」菜单里的条目 */
  'chat.composer.menu': { chatId: string; setText: (text: string) => void; close: () => void }
  /** 每条消息的「⋯」菜单里的条目 */
  'chat.message.actions': { chatId: string; message: MessageDTO }
  /** 会话设置面板里的分组（和角色编辑器的分组一样，自动包成可折叠的分组，标题用贡献的 title） */
  'chat.settings.sections': { chatId: string }
  /** 每条消息正文下方 */
  'chat.message.footer': { chatId: string; message: MessageDTO }
  /** 聊天页侧栏底部 */
  'sidebar.footer': Record<string, never>
}
export type SlotName = keyof SlotProps

export interface SlotContribution<K extends SlotName> {
  /** 在同一个插槽里唯一 */
  id: string
  /** 可折叠分组的标题，未提供时使用 id。 */
  title?: string
  render: (props: SlotProps[K]) => ReactNode
  /** 越小越靠前，默认 100 */
  order?: number
}

/** 扩展注册的页面：显示在扩展页里该扩展详情的标签中 */
export interface PageContribution {
  /** 在扩展内唯一；页面的 view 名是 ext:<扩展 id>:<id> */
  id: string
  label: string
  /** 标签和列表快捷按钮显示的图标：一个 emoji 或一两个字 */
  icon: string
  render: () => ReactNode
}

/** 前端事件：扩展可以订阅 */
export type ClientEvent =
  | { type: 'image:swipe-next'; chatId: string; message: MessageDTO }
  | { type: 'chat:open'; chatId: string | null }
  | { type: 'generation:start'; chatId: string }
  | { type: 'generation:complete'; chatId: string }
  | { type: 'message:sent'; chatId: string; text: string }

export interface ClientExtensionAPI {
  registerCommand: (command: SlashCommand) => void
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
  openChat: (chatId: string) => Promise<void>
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
