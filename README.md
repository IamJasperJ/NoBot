# AI-Parter

一个轻量、快速的 AI 角色扮演 / 陪伴 / 跑团应用。兼容酒馆（SillyTavern）的角色卡，只保留核心功能，长对话也不卡。

设计文档：<https://claude.ai/code/artifact/4fbca930-93b0-4d93-a6fe-5fffca832518>

## 快速开始

需要 [Bun](https://bun.sh) 1.4 以上（macOS：`brew install oven-sh/bun/bun`）。

```bash
bun install
bun run dev
```

浏览器打开 <http://localhost:5173>：

1. 点左上角的齿轮 → 「模型接口」，添加一个 OpenAI 兼容接口（DeepSeek、OpenRouter、各类中转站都行），点「测试并获取模型」确认能连上
2. 「我的人设」里改成你想在故事里用的名字（角色卡里的 `{{user}}` 会替换成它）
3. 左侧「导入角色卡」，选酒馆的 PNG 或 JSON 角色卡
4. 点角色 → 「新建会话」，开始聊天

### 日常使用（生产模式）

```bash
bun run build   # 打包前端，只需在代码更新后执行一次
bun start       # 只启动一个进程，打开 http://127.0.0.1:3000
```

想用手机访问（同一个局域网）：`HOST=0.0.0.0 bun start`，然后手机打开 `http://电脑的局域网IP:3000`。
注意：这样同一网络里的任何人都能用你配置的 API Key，只在自己家里的网络这样做。

## 数据在哪

所有数据都在 `data/` 目录：`data/app.db`（SQLite 数据库）和 `data/assets/avatars/`（头像）。
备份就是复制整个 `data/` 目录。也可以用环境变量 `DATA_DIR` 指定到别的位置。

## 已有功能

- 导入酒馆角色卡（PNG 的 V2 / V3，以及 JSON），备选开场白自动变成开场白的 swipe
- OpenAI 兼容接口的流式聊天，支持 DeepSeek 等模型的「思考过程」
- 消息树：重新生成、左右切换 swipe、编辑、删除（连同后面的分支）、中止生成
- 生成在后端进行：刷新页面或断网后能接着显示，不会丢
- Prompt 预览：查看下一次会发给模型的完整内容，每段标注来源和 token 数
- 宏：`{{char}}` `{{user}}` `{{time}}` `{{date}}` `{{random::a::b}}` `{{roll:2d6+3}}` 等
- 长对话性能：虚拟列表 + 分页加载，5000 条消息的会话打开即到底部，滚动不卡

## 还没做（按计划顺序）

- 里程碑 4：可编辑的 Prompt 预设（自定义各段顺序和模板）、作者注释的编辑界面
- 里程碑 5：世界书（导入、编辑、关键词触发）。角色卡自带的世界书已原样保存在数据库里，到时会自动拆出来
- 里程碑 6：性能验收、角色卡导出、导入酒馆聊天记录

## 开发

```bash
bun test            # 单元测试（packages/core）
bun run typecheck   # 所有包的类型检查
bun run lint        # Biome 代码检查
bun run format      # 自动格式化
bun run db:generate # 修改 apps/server/src/db/schema.ts 后生成迁移
```

目录结构：

```
packages/shared   前后端共用的类型和 Zod 校验规则
packages/core     纯逻辑：Prompt 组装、宏、角色卡解析、消息树计算（不碰数据库和网络）
apps/server       Bun + Hono 后端：数据库、接口、调用模型
apps/web          React 前端
```
