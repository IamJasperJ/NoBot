import type {
  ExtensionCatalogDTO,
  ExtensionDTO,
  ExtensionInstallInput,
  ExtensionInstallPreview,
  ExtensionUpdateResult,
  GitStatusDTO,
} from '@ai-parter/shared'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { loadExtensions } from '../extensions/runtime'
import { t } from '../i18n'
import { api } from './client'
import { keys } from './queries'

/** 状态操作完成后等待查询刷新和前端清理，让调用方拿到的成功状态包含热重载。 */
function useRefreshExtensions() {
  const qc = useQueryClient()
  return async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: keys.extensions }),
      qc.invalidateQueries({ queryKey: keys.tools }),
      qc.invalidateQueries({ queryKey: keys.extensionCatalog }),
      loadExtensions(qc),
    ])
  }
}

/**
 * 扩展管理（G3 安装 / 更新、G4 权限确认、扩展目录）的前端数据层。
 * 界面（ExtensionsPage 等）只通过这里的 hooks 调接口；每个改变扩展状态的操作完成后都要：
 *   1. 刷新 keys.extensions 和 keys.tools 查询
 *   2. 调 runtime 的 loadExtensions 热重载该扩展的前端部分（client.js / style.css 按 revision 绕过缓存）
 * 出错时把错误抛给调用方（界面负责 toast），hooks 自己不弹提示。
 */

/** 服务器上 Git 是否可用（GET /api/extensions/git），没有 git 时界面禁用「从 Git 安装」并给出提示 */
export function useGitStatus(): { data: GitStatusDTO | undefined; isPending: boolean } {
  return useQuery({ queryKey: keys.gitStatus, queryFn: api.getGitStatus })
}

/**
 * 两步安装流程：start 克隆并拿到预览（含权限）→ 用户确认后 confirm 真正安装，或 cancel 放弃。
 * - start 期间 previewing=true；同一时间只有一个预览，再次 start 会先取消旧的暂存
 * - confirm(enable) 返回安装好的扩展；enable=true 时同时确认权限并启用
 * - 组件卸载时如果还有未确认的预览，自动 cancel（避免暂存目录残留到超时）
 */
export function useInstallFlow(): {
  preview: ExtensionInstallPreview | null
  previewing: boolean
  confirming: boolean
  start: (input: ExtensionInstallInput) => Promise<ExtensionInstallPreview>
  confirm: (enable: boolean) => Promise<ExtensionDTO>
  cancel: () => Promise<void>
} {
  const refresh = useRefreshExtensions()
  const [preview, setPreview] = useState<ExtensionInstallPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const current = useRef<ExtensionInstallPreview | null>(null)
  const mounted = useRef(true)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  // 请求串行化，旧预览在创建下一份之前必须取消；失败不能阻塞后续操作。
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.current.then(operation)
    queue.current = result.catch(() => {})
    return result
  }
  const clearPreview = () => {
    current.current = null
    if (mounted.current) setPreview(null)
  }
  const cancelCurrent = async () => {
    if (!current.current) return
    await api.cancelExtensionInstall(current.current.token)
    clearPreview()
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      // 排在在途请求之后清理，兼顾预览响应晚于卸载和 StrictMode 的模拟卸载。
      void enqueue(async () => {
        if (!mounted.current) await cancelCurrent()
      }).catch(() => {})
    }
  }, [])
  return {
    preview,
    previewing,
    confirming,
    start: (input) =>
      enqueue(async () => {
        if (mounted.current) setPreviewing(true)
        try {
          await cancelCurrent()
          const result = await api.previewExtensionInstall(input)
          current.current = result
          if (mounted.current) setPreview(result)
          else await cancelCurrent()
          return result
        } finally {
          if (mounted.current) setPreviewing(false)
        }
      }),
    confirm: (enable) =>
      enqueue(async () => {
        if (!current.current) throw new Error(t('没有待确认的扩展安装'))
        if (mounted.current) setConfirming(true)
        try {
          const result = await api.confirmExtensionInstall(current.current.token, enable)
          clearPreview()
          await refresh()
          return result
        } finally {
          if (mounted.current) setConfirming(false)
        }
      }),
    cancel: () => enqueue(cancelCurrent),
  }
}

/**
 * 单个 Git 扩展的操作。busy 为任一操作进行中。
 * - checkUpdate：git fetch 并比较，结果体现在返回的扩展和 keys.extensions 里
 * - update：git pull；返回值里 permissionsChanged=true 表示扩展已被停用，等待重新确认
 * - loadBranches：按需拉取分支和标签（打开切换菜单时才调用）
 * - switchRef：切换分支 / 标签
 * - uninstall：卸载（删除目录和设置）；成功后如果当前选中的是它，界面自己负责回到列表
 */
export function useExtensionGit(id: string): {
  busy: boolean
  checkUpdate: () => Promise<ExtensionDTO>
  update: () => Promise<ExtensionUpdateResult>
  loadBranches: () => Promise<{ current: string; branches: string[] }>
  switchRef: (ref: string) => Promise<ExtensionDTO>
  uninstall: () => Promise<void>
} {
  const refresh = useRefreshExtensions()
  const [pending, setPending] = useState(0)
  const track = async <T>(operation: () => Promise<T>, changesState = true) => {
    setPending((count) => count + 1)
    try {
      const result = await operation()
      if (changesState) await refresh()
      return result
    } finally {
      setPending((count) => count - 1)
    }
  }
  return {
    busy: pending > 0,
    checkUpdate: () => track(() => api.checkExtensionUpdate(id)),
    update: () => track(() => api.updateExtensionCode(id)),
    loadBranches: () => track(() => api.getExtensionBranches(id), false),
    switchRef: (ref) => track(() => api.switchExtensionRef(id, ref)),
    uninstall: () =>
      track(async () => {
        await api.uninstallExtension(id)
      }),
  }
}

/** 确认扩展当前的权限并启用（PATCH enabled=true + approvePermissions=true），返回更新后的扩展 */
export function useApproveExtension(): { approve: (id: string) => Promise<ExtensionDTO>; busy: boolean } {
  const refresh = useRefreshExtensions()
  const mutation = useMutation({
    mutationFn: (id: string) => api.updateExtension(id, { enabled: true, approvePermissions: true }),
    onSuccess: refresh,
  })
  return { approve: mutation.mutateAsync, busy: mutation.isPending }
}

/** 重新扫描 data/extensions（手动放进目录的扩展不用重启就能加载） */
export function useReloadExtensions(): { reload: () => Promise<ExtensionDTO[]>; busy: boolean } {
  const refresh = useRefreshExtensions()
  const mutation = useMutation({ mutationFn: api.reloadExtensions, onSuccess: refresh })
  return { reload: mutation.mutateAsync, busy: mutation.isPending }
}

/**
 * 扩展目录：enabled=false 时不请求（只有切到「扩展目录」标签才拉）。
 * refresh 强制服务器重新拉取索引（?refresh=1）。
 */
export function useExtensionCatalog(enabled: boolean): {
  data: ExtensionCatalogDTO | undefined
  isPending: boolean
  isFetching: boolean
  error: unknown
  refresh: () => Promise<void>
} {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: keys.extensionCatalog,
    queryFn: () => api.getExtensionCatalog(),
    enabled,
  })
  const [refreshing, setRefreshing] = useState(false)
  return {
    data: query.data,
    isPending: query.isPending,
    isFetching: query.isFetching || refreshing,
    error: query.error,
    refresh: async () => {
      setRefreshing(true)
      try {
        // 先取消旧请求，避免旧索引在强制刷新结束后覆盖新结果。
        await qc.cancelQueries({ queryKey: keys.extensionCatalog })
        const result = await qc.fetchQuery({
          queryKey: keys.extensionCatalog,
          queryFn: () => api.getExtensionCatalog(true),
          staleTime: 0,
        })
        qc.setQueryData(keys.extensionCatalog, result)
      } finally {
        setRefreshing(false)
      }
    },
  }
}

/** 扩展目录的索引地址列表；save 后自动刷新目录 */
export function useCatalogSources(): {
  urls: string[] | undefined
  save: (urls: string[]) => Promise<void>
  saving: boolean
} {
  const qc = useQueryClient()
  const query = useQuery({ queryKey: keys.catalogSources, queryFn: api.getCatalogSources })
  const mutation = useMutation({
    mutationFn: api.saveCatalogSources,
    onSuccess: async (result) => {
      qc.setQueryData(keys.catalogSources, result)
      await qc.invalidateQueries({ queryKey: keys.extensionCatalog })
    },
  })
  return {
    urls: query.data?.urls,
    save: async (urls) => {
      await mutation.mutateAsync(urls)
    },
    saving: mutation.isPending,
  }
}
