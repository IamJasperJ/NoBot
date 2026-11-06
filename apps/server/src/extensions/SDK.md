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
