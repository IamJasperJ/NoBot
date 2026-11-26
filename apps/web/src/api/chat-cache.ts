import type { ChatPage, MessageDTO } from '@nobot/shared'
import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import { api } from './client'
import { keys } from './query-keys'

type ChatCache = InfiniteData<ChatPage, string | undefined>

/** 把分页数据拍平成从旧到新的一个数组 */
export function flattenPages(data: { pages: ChatPage[] } | undefined): MessageDTO[] {
  if (!data) return []
  return [...data.pages].reverse().flatMap((p) => p.messages)
}

/**
 * 把新消息接到缓存里的对话末尾。
 * 规则和后端消息树一致：找到新消息的父节点，父节点之后的内容全部换成新消息。
 * 所以「发送」是追加，「重新生成」是替换掉旧回复，都用这一个函数。
 * null 父节点表示从根开始的新路径；其他父节点不在缓存里时返回 false，调用方应该重新拉取。
 */
export function applyNewMessage(qc: QueryClient, chatId: string, msg: MessageDTO): boolean {
  let ok = false
  qc.setQueryData<ChatCache>(keys.chat(chatId), (data) => {
    const newest = data?.pages[0]
    if (!data || !newest) return data
    if (msg.parentId === null) {
      ok = true
      return {
        pages: [{ ...newest, messages: [msg], hasMore: false }],
        pageParams: [undefined],
      }
    }
    for (const [k, page] of data.pages.entries()) {
      const i = page.messages.findIndex((m) => m.id === msg.parentId)
      if (i < 0) continue
      ok = true
      const updated: ChatPage = {
        ...newest,
        messages: [...page.messages.slice(0, i + 1), msg],
        hasMore: page.hasMore,
      }
      // 比第 k 页更新的页都在父节点之后，整页丢掉
      // 提升到首页时清除原游标，后续重新拉取必须从后端当前叶节点开始。
      return { pages: [updated, ...data.pages.slice(k + 1)], pageParams: [undefined, ...data.pageParams.slice(k + 1)] }
    }
    return data
  })
  return ok
}

/** 发送失败或收到正式消息时，移除对应的临时消息，保留各页游标。 */
export function removeCachedMessages(qc: QueryClient, chatId: string, matches: (message: MessageDTO) => boolean) {
  qc.setQueryData<ChatCache>(keys.chat(chatId), (data) => {
    if (!data) return undefined
    const pages = data.pages.map((page) => {
      const messages = page.messages.filter((message) => !matches(message))
      return messages.length === page.messages.length ? page : { ...page, messages }
    })
    return pages.some((page, i) => page !== data.pages[i]) ? { ...data, pages } : undefined
  })
}

/** 用新数据替换缓存里的某条消息（编辑完成、生成结束时用） */
export function replaceMessage(qc: QueryClient, chatId: string, msg: MessageDTO) {
  let found = false
  qc.setQueryData<ChatCache>(keys.chat(chatId), (data) => {
    if (!data) return data
    const pages = data.pages.map((page) => {
      const index = page.messages.findIndex((message) => message.id === msg.id)
      if (index < 0) return page
      found = true
      return { ...page, messages: page.messages.with(index, msg) }
    })
    return found ? { ...data, pages } : data
  })
  return found
}

/**
 * 只刷新会话页里由整条路径算出来的字段（舞台、变量、生效的玩法预设），不动已加载的消息。
 * 生成完成、编辑消息之后调用：这些操作只替换了单条消息，但舞台和变量是沿路径累加的。
 */
export async function refreshChatState(qc: QueryClient, chatId: string) {
  try {
    const latest = await api.getChatPage(chatId)
    qc.setQueryData<ChatCache>(keys.chat(chatId), (data) =>
      data && (data.pages[0]?.messages.at(-1)?.id ?? null) === latest.chat.activeLeafId
        ? {
            ...data,
            pages: data.pages.map((p) => ({
              ...p,
              chat: latest.chat,
              group: latest.group,
              stage: latest.stage,
              vars: latest.vars,
              playPresetId: latest.playPresetId,
              stateSchema: latest.stateSchema,
            })),
          }
        : data,
    )
  } catch {
    // 只是附带刷新，失败了不打扰用户；下次打开会话时会拿到最新数据
  }
}

/** 同步缓存里的后端任务状态，涵盖尚未开始输出和工具轮之间的等待。 */
export function setChatGenerating(qc: QueryClient, chatId: string, generating: boolean) {
  qc.setQueryData<ChatCache>(keys.chat(chatId), (data) =>
    data ? { ...data, pages: data.pages.map((p) => ({ ...p, generating })) } : data,
  )
}

/**
 * 消息树结构变了（切换 swipe、删除消息）：丢掉旧分页游标，重新拉最新一页。
 * 不能用普通的 refetch，因为旧页的分页参数可能已经不在新路径上了。
 */
export async function resetChat(qc: QueryClient, chatId: string) {
  // 分支变了（swipe、移动、删除、切换书签分支）：书签的「是否在当前分支」也要跟着刷新
  void qc.invalidateQueries({ queryKey: keys.bookmarks(chatId) })
  const queryKey = keys.chat(chatId)
  await qc.cancelQueries({ queryKey, exact: true })
  // 保留最新一页直到新路径返回，避免加载态卸载 VN、重置播放器的自动模式。
  qc.setQueryData<ChatCache>(queryKey, (data) =>
    data?.pages[0] ? { pages: [data.pages[0]], pageParams: [undefined] } : data,
  )
  return qc.invalidateQueries({ queryKey, exact: true })
}
