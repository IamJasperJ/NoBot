# 扩展加载、兼容性与后台任务

## 权限与加载

扫描目录只读取 `manifest.json`，未获批准的后端入口不会导入，也不会执行模块顶层代码。
声明新增权限的版本必须重新确认之后才会导入。批准之前不暴露动态设置、工具、钩子，
也不返回已保存的设置值，避免无法读取设置 schema 时泄露密钥。

旧扩展没有 manifest 时，以目录名作为稳定 id；导出对象中的 id 不再覆盖该标识。
没有 permissions 的后端扩展保守地请求全部后端能力。推荐补充 manifest 并逐项声明权限。
权限仍是可信代码授权，后端代码在同一个进程内运行；network 是声明而不是网络隔离。

管理代码需要批准并加载插件时，使用异步 `configureExtension()` 并等待返回。
同步 `updateExtension()` 保留给已经加载的扩展修改设置或开关。

## API 版本与类型入口

manifest 可以声明 `"apiVersion": 1`。省略等同 1；当前宿主只接受 1，
其他版本在执行代码之前报错，包括安装预览和 Git 更新预检。

类型统一从 `apps/server/src/extensions/sdk.ts` 导入。外置插件发布时应擦除类型导入，
不要在安装目录用相对路径运行时导入宿主源码。可以使用无依赖的恒等包装：

```ts
import type { Extension } from '../../apps/server/src/extensions/sdk'
const defineExtension = (extension: Extension): Extension => extension
```

## 统一后台任务

在 `startBackground(ctx, signal)` 中注册稳定的任务 id：

```ts
startBackground(ctx, signal) {
  ctx.tasks.register({
    id: 'refresh',
    name: '刷新 / Refresh',
    schedule: { kind: 'interval', everyMs: 60000, anchor: 0 },
    misfire: 'skip',
  }, async (taskSignal) => {
    await refresh({ signal: taskSignal })
  })
}
```

需要声明并批准 `background` 权限。传给回调的信号包含扩展生命周期、用户库关闭和单任务取消，
网络和模型调用必须传递它。宿主等待回调返回，阻止同一任务重叠执行，并记录成功、异常类型和完成时间。
不要在回调中启动未返回的 Promise，否则宿主无法追踪实际完成或失败。

支持的计划：

- `{ kind: 'once', at: 毫秒时间戳 }`
- `{ kind: 'interval', everyMs: 间隔毫秒, anchor: 对齐基准时间戳 }`，至少 1000 毫秒。
- `{ kind: 'daily', time: '08:00', timeZone: 'Asia/Shanghai' }`

每天计划使用明确的 IANA 时区；夏令时跳过不存在的本地时间，重复的本地时间每天只取一次。
`misfire: 'skip'` 跳过落后超过 60 秒的执行；`'once'` 在恢复后补一次，不逐次重放错过的周期。
检查粒度约一秒，不承诺精确到秒。NoBot 服务必须运行；操作系统睡眠或关机时不能执行。

状态保存在每用户数据库的 settings 表内，键为 `scheduled-task:<id>`，
复用系统库的后台索引恢复具有用户任务的账号，不额外引入数据库迁移或依赖。
执行前先保存下一轮时间；进程中断时记录 interrupted，不自动重放结果不确定的动作。
这保证避免自动重复投递，但不承诺外部副作用的“恰好一次”。

暂停会保留任务，并向正在执行的回调发出取消信号；删除会取消并删除状态。
取消依赖回调遵守信号，不能撤回已经发生的副作用。手动执行允许重试失败任务，
不修改周期任务原计划；一次性任务执行后不会自动再执行。
插件禁用时不再调度其任务，启用后根据原计划处理错过的执行；卸载时删除任务。
旧式自己调用 setInterval 的插件仍能运行，但只有接入 ctx.tasks 才能获得每轮执行状态。

## 更新恢复

Git 更新和分支切换在独立副本完成准备和 manifest/API 校验。
切换加载失败或后台启动立即失败时恢复旧目录、权限设置和运行实例。
新增权限需要确认时，保留旧副本直到确认并成功加载；确认后的加载失败也会回滚。
等待确认期间拒绝继续叠加更新或切换版本。

回滚范围是插件代码和启用/批准设置，不能撤回插件在顶层或启动过程中已产生的外部副作用。
长时间运行后发生的故障通过状态和手动重试处理，不自动回滚代码。

## 渠道平台（v2）

后台声明 `permissions: { background: true, channels: true }` 后，可以在
`startBackground(ctx, signal)` 中调用 `ctx.channels.registerProvider(definition)`。
未声明 `channels` 的注册调用会抛出 `CHANNEL_PERMISSION_REQUIRED`；工具、钩子和路由的
上下文也提供只读的 `channels.lookup(chatId)` / `channels.lookupAll(chatId)`，不需要渠道权限。
`registerProvider` / `ensureAccount` 仅限当前后台生命周期使用。
`registerProvider` 返回 `{ unregister(): void }`；注销会停止平台全部账号、使旧 IO 失效、
显示 `PROVIDER_UNAVAILABLE`，并保留账号、绑定、会话和日志。重复注销无副作用；
可再次注册同名平台，宿主自动启动此前 enabled 的账号。后台 signal 中止也会自动注销，
旧后台或旧注销句柄不会影响后来的注册。

`ensureAccount(providerId, { name, characterId?, groupId? })` 返回
`{ accountId, characterFollowed: boolean }`。新建账号保存 `providerState.ensuredCharacterId`，
传入角色时 `characterFollowed: true`；未传角色时为 false。已有账号仅在传入角色且当前
`characterMode === 'fixed'`、当前角色等于上次 ensuredCharacterId 时跟随并更新记录，
否则返回 false，保留用户设置。其他设置不覆盖，已停用账号不重新启用。

SDK 导出 `ChannelProviderDefinition`、`ChannelProviderAccount`、`ChannelProviderIO`、
`ChannelInboundMessage`、`ChannelLookup`、`ExtensionChannels`、`ChannelSendError` 和
`ChannelProviderStoppedError`。完整字段及 REST 接口见
[渠道平台接口](../../../../docs/design/channel-providers.md)。

```ts
import { defineExtension, ChannelSendError } from './sdk'

export default defineExtension({
  id: 'example', name: 'Example', version: '1.0.0', description: 'Example channel',
  async startBackground(ctx, signal) {
    ctx.channels.registerProvider({
      id: 'dm', name: 'Example DM', scopes: ['private'], canInitiate: false,
      limits: { maxTextLength: 500, minIntervalMs: 1000, perMinute: 20 },
      media: { inboundImages: true, outboundImages: false, voice: false },
      accountFields: [], defaults: { newLocation: { private: 'approve' } },
      promptHint: 'This is a direct message. Reply briefly in plain text. Write in the same language as the conversation.',
      async start(account, io, accountSignal) {
        io.status('online')
        // 将 io 交给平台接收器；账号信号中止后停止接收器。
        await new Promise<void>((resolve) => accountSignal.addEventListener('abort', () => resolve(), { once: true }))
      },
      async send(account, message, accountSignal) {
        // 只接收单段纯文本。平台确认未发送时才能声明 not-sent。
        throw new ChannelSendError('not-sent', 'BUDGET', { retryAfterMs: 60000 })
      },
    })
    await ctx.channels.ensureAccount('dm', { name: 'Example DM' })
  },
})
```

`io` 可以保存在接收器中，从任意异步上下文调用；宿主自动恢复所属用户上下文。
账号信号中止后，`emit`、`status`、`saveCursor`、`setOwner` 都会同步抛出
`ChannelProviderStoppedError`，可按 `error.name` 判断。`start` 返回不表示账号停止。
账号启动时状态为 `connecting`，发送队列会等待；**插件就绪后必须调用 `io.status('online')`，否则不会发送**。
`emit` 在消息落库或进入批准／持久化排队流程后 resolve；不会等待模型生成或回复投递。
入站触发的授权提示、命令回复也只等待加入发送队列，后台发送错误记入渠道日志。
`saveCursor` 接受可 JSON 序列化的游标。`setOwner(id)` 声明已配对主人，`null` 撤销本账号的声明。

插件平台等待批准的新位置会保存最近 20 条输入（文字、context、sentAt 和图片附件引用）；
批准后按 sentAt 稳定排序落库，再按房间接话／排队规则调度一轮生成，拒绝或拉黑时丢弃。
`canInitiate:false` 的非主人回复按数据库父链判定：最近的 user 必须来自当前平台和位置，
回复距离该入站不超过 30 分钟，且入站的其他子分支没有已提交的投递。同分支连发和工具降级文本可继续投递，
不依赖宿主进程的任务内存，也不区分生成由谁触发（房间判断后的回合、网页上点生成都算答复）；
最近的 user 不是入站、超出窗口或网页镜像仍拦截。此类平台新会话历史不保留角色卡开场白。

`managedAccounts: true` 表示账号由扩展用 `ensureAccount` 管理，渠道页不显示手动添加；省略时 `accountFields` 为空即视为托管。
`GET /api/ext/channels/providers` 返回 `extensionId`、`extensionName` 和 `managed`，内置平台分别为 null、null、false。

`ChannelSendError('not-sent', code, { retryAfterMs })` 表示确定没有发出，可自动重试最多三次（retryAfterMs 超过 10 分钟时不等待，直接判定这段未发出，避免堵住同一账号的其他会话）；
账号仍 online 时，没有重试间隔的 `not-sent` 直接记失败。
如果插件先报告 paused / offline / connecting 等非 online 状态，再抛 `not-sent`（例如验证码），
宿主等待恢复 online 后重发当前段，不要求 retryAfterMs，也不消耗三次重试预算。`unknown` 和其他异常只记结果不确定，绝不自动重发。
宿主按 `error.name === 'ChannelSendError'` 识别跨模块错误。投递失败日志保留 kind、code、message；
其他异常保留 name、message，最多 300 字，未知异常仍按结果不确定处理，不自动重发。
暂停期间同一发送队列冻结，恢复 `online` 后继续；账号停止会取消等待中的发送。
