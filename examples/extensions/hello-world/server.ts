// 只导入类型，运行时不依赖仓库路径，所以自定义 DATA_DIR 下也可直接使用。
import type { Extension } from '../../../apps/server/src/extensions/types'

// 与宿主 defineExtension 相同的恒等辅助函数，用于获得完整类型提示。
const defineExtension = (extension: Extension): Extension => extension

export default defineExtension({
  id: 'hello-world',
  name: '你好，扩展世界',
  version: '1.0.0',
  description: '扩展系统的完整示例',
  // 第三方扩展默认停用；在扩展管理页启用后，宏、工具、事件和接口才生效。
  defaultSettings: { greeting: '你好，冒险者！' },
  settingsSchema: [{ key: 'greeting', label: '问候语', type: 'string' }],
  macros: {
    // 宏上下文始终包含最新设置；可在角色描述中写 {{hello}}。
    hello: (_arg, ctx) => String(ctx.settings.greeting),
  },
  tools: [
    {
      name: 'get_lucky_number',
      description: '抽取一个 1 到 100 的幸运数字。',
      parameters: { type: 'object', properties: {} },
      run: () => ({ content: `你的幸运数字是 ${1 + Math.floor(Math.random() * 100)}` }),
    },
  ],
  routes(app, ctx) {
    // routes 只在启动时执行一次；ctx.settings 是动态读取的，不要提前缓存设置值。
    app.get('/stats', (c) => c.json({ messages: ctx.storage.get<number>('messages') ?? 0 }))
  },
  hooks: {
    onEvent(event, ctx) {
      // 统计所有实际保存的用户、助手和工具消息，不统计流式分片。
      if (event.type === 'message:saved') {
        ctx.storage.set('messages', (ctx.storage.get<number>('messages') ?? 0) + 1)
      }
    },
  },
})
