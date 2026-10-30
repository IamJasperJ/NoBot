# 扩展平台接口

前端默认导出 `activate(api)`，返回清理函数；停用时会移除所有插槽贡献。内置前端在
`apps/web/src/extensions/builtin/index.ts` 的 `BUILTIN_CLIENTS` 注册，同样使用此生命周期。

- `extensions.settings.footer`：收到 `{ extensionId, settings }`，显示在设置表单下方；只显示当前扩展自己的贡献。settings 是尚未保存的草稿。
- `chat.message.media`：收到 `{ chatId, message }`，位于图片区域下方，工具消息也会显示，可放重试等按钮。
- `vn.stage.overlay`、`vn.hud.items`、`vn.dialog.footer`：VN 画面上的叠加层、状态栏项和对话框底部控件，收到当前演出位置（message、beatIndex、speaker、text、reasoning 等）；示例在叠加层显示说话人、在状态栏显示拍数，并订阅 `vn:line` / `vn:directive` 打印到控制台。
- 原有 `chat.header.actions`、`chat.composer.menu`、`chat.message.actions`、`chat.message.footer`、`sidebar.footer` 继续可用。

后端钩子和工具通过 `ctx.host` 使用宿主；路由注册上下文也包含 host：

```ts
routes(app, ctx) {
  app.post('/describe', async (c) => {
    const { chatId } = await c.req.json()
    const info = ctx.host.getChatInfo(chatId, 20)
    const text = await ctx.host.quietPrompt({ chatId, instruction: '描述当前场景', maxTokens: 200 })
    return c.json({ text, persona: info.persona })
  })
}
```

`quietPrompt` 使用当前连接、角色、世界书和生成预设，不保存聊天消息；默认包含历史，
传 `includeHistory: false` 可去掉聊天记录，`role` 默认 system，也支持 user 和 AbortSignal。
`saveImage(bytes)` 保存图片附件；`appendMessage(chatId, message)` 追加消息并切换叶子，
会话生成期间返回 BUSY；`updateMessageMeta(id, patch)` 浅合并元数据，数组整体替换。
两者分别触发 `message:saved` 和 `message:updated`。`isGenerating(chatId)` 查询生成状态，
`log({ kind: 'extension' | 'image', status, summary, request, response })` 记录请求日志。

`tools` 可以是数组，也可以是 `(ctx) => ToolDefinition[]`，根据当前设置返回工具。
工具的 `ctx.extension` 是该扩展的上下文，chatId 来自工具调用。
工具返回 `{ content, meta, onSaved }` 时，meta 合并进工具消息，onSaved 在保存后收到消息 id，
可启动异步任务并用宿主更新这条消息。回调出错会记录日志，生成流程继续。

设置字段支持 visibleWhen 条件显示、string.secret 密码框、placeholder、textarea.rows、
number.step，以及只有标题和可选说明的 heading。图片任务元数据由具体扩展负责写入，平台只负责展示和刷新。

`api.registerPage({ id, label, icon, render })` 注册的管理页面显示在「扩展」页中该扩展详情的标签里，
第一个标签固定为「设置」，后面是图标和页面名称；没有注册页面的扩展保持普通详情。
左侧导航只显示应用功能。扩展列表右侧的页面图标可一步打开对应标签。
调用 `api.openView('ext:hello-world:hello')`（扩展 ID 以 manifest 为准）也会打开扩展面板并切到对应标签。
切换标签保留未保存的设置；停用扩展会清理页面并回到该扩展的「设置」标签。
