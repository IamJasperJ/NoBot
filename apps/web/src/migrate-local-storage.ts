/** 改名前的本机设置只搬一次；新设置优先，写入失败时保留旧值以便下次重试。 */
export function migrateLocalStorage(storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
  try {
    const target = storage ?? localStorage
    for (const suffix of ['language', 'appearance', 'sprite-layout', 'selection']) {
      const oldKey = `ai-parter:${suffix}`
      const newKey = `nobot:${suffix}`
      const value = target.getItem(oldKey)
      if (value === null) continue
      if (target.getItem(newKey) === null) target.setItem(newKey, value)
      target.removeItem(oldKey)
    }
  } catch {
    // 浏览器禁用存储或配额不足时仍允许启动，旧值留待之后迁移。
  }
}

// 入口首先导入本模块，必须早于其他模块在初始化时读取语言和 Zustand 状态。
migrateLocalStorage()
