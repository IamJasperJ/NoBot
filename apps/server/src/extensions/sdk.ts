// 入口只导出类型和恒等包装，不加载数据库或内置扩展；已发布插件应擦除类型导入。

export type { ScheduledTaskDTO, TaskSchedule } from '@nobot/shared'
export type { BackgroundTaskDefinition, BackgroundTasks } from './tasks'
export type {
  Extension,
  ExtensionContext,
  ExtensionHost,
  ExtensionManifest,
  ExtensionStorage,
  ServerEvent,
} from './types'
export function defineExtension<T extends import('./types').Extension>(extension: T): T {
  return extension
}
