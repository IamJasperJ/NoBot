<div align="center">

# NoBot

**兼容 SillyTavern 生态的 AI 角色扮演平台，以视觉小说的形式呈现对话。**

模型负责叙事，NoBot 负责演出：立绘、背景、CG、配乐与逐句配音由舞台指令驱动，分支选择交由用户决定。

简体中文 · [English](README.en.md)

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
![Bun](https://img.shields.io/badge/Bun-1.4-black?logo=bun)
![TypeScript](https://img.shields.io/badge/TypeScript-7-3178c6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=black)
![Docker](https://img.shields.io/badge/Docker-ready-2496ed?logo=docker&logoColor=white)

<img src=".github/assets/vn-mode-stage.jpg" alt="VN 模式：三个角色同台，背景、选项和状态栏" width="900">

<sub>实际运行截图：D&D 跑团角色卡在 VN 模式下运行，三名角色同台，背景按场景自动生成，第二个选项附带「威吓 DC12」检定</sub>

</div>

## 设计目标

| 常见问题 | NoBot 的方案 |
|---|---|
| 现有的 VN 模式仅在聊天界面旁切换角色表情 | 由模型输出**舞台指令**，逐句演出角色登场、站位、表情、场景切换、CG、BGM 与分支选项 |
| 立绘与背景需要手动收集、抠图和命名 | 支持一键生成整套表情立绘并自动抠图；剧情进入新场景时，若背景库中无匹配项则**自动生成背景**，并由视觉模型命名 |
| 语音合成会朗读 `*叹气*`、`<laugh/>` 等标记，且所有角色共用同一音色 | 为每个角色分配独立音色，未指定时按性别自动分配；耳语、喊叫、笑声、叹息等语气标记按各引擎的支持方式转换，无法识别的标记不会被朗读 |
| 群聊中多个角色的回复互相打断 | 同一轮的多条回复**按顺序演出与朗读**，并支持在生成过程中同步朗读 |
| 跑团时由模型自行掷骰，结果缺乏约束 | 掷骰与检定由 NoBot 执行，**模型无法改写结果**；HP、背包等状态随消息树记录，重新生成时自动回退 |
| 刷新页面或网络中断会丢失正在生成的回复 | 生成任务在服务端执行，刷新或重连后**继续显示**；消息列表采用虚拟滚动，长对话保持流畅 |
| 世界书条目未触发时难以排查原因 | Prompt 预览逐条列出触发原因（关键词、常驻、粘滞、向量匹配）及跳过原因（冷却、预算、概率、包含组） |
| 安装扩展需要重启，且权限不透明 | 通过 Git 地址安装、更新、切换分支与卸载均**无需重启**，启用前列出所需权限 |

## 核心特性

### 🎭 舞台指令驱动的视觉小说

模型在正文中输出舞台指令（支持速记与 XML 两种格式，兼容 MVU 变量写法）。聊天视图中指令会被隐藏，VN 视图中按句演出：

- **登场与站位**：角色登场、退场、切换表情与服装，其余角色自动重新居中；没有立绘的 NPC 可生成临时立绘
- **场景与 CG**：场景指令驱动背景切换；`<cg>` 指令生成全屏插图，并收录到角色的 CG 画廊
- **选项与状态**：回复末尾的选项呈现为选择肢，带检定的选项标注技能与难度；好感阶段、HP 等状态显示在 HUD 中，数值变化以浮动文字提示
- **完整的 VN 操作**：ADV / NVL 版式、打字机效果、自动播放、快进（可限定为已读内容）、回想与「从此处重演」、回退、带缩略图的存档与读档、电影模式（上下黑边，仅保留字幕）
- **群聊顺序演出**：同一轮中多个角色依次回复时，按顺序逐条演出，并支持边生成边演出
- **玩法预设**：内置普通聊天、陪伴、Galgame、RPG、D&D 5e 预设，指令格式、版式、HUD 与选项样式均可配置

<div align="center">
<img src=".github/assets/chat-view-with-sprite.jpg" alt="同一会话的聊天视图" width="900">
<br><sub>同一会话的聊天视图：舞台指令已隐藏，台词标注说话人，侧边显示立绘</sub>
</div>

### 🎨 立绘与背景自动生成

- **立绘**：按表情批量生成整套立绘（以首张为参考保持外貌一致），支持多套服装与拖动缩放站位，可直接导入 SillyTavern 立绘包
- **抠图**：提供三种方式——基础算法、由出图服务直接输出透明背景（ComfyUI 需安装对应节点）、本地抠图模型（选用时下载）；已有立绘可重新抠图
- **背景**：剧情进入新场景时，先按名称与描述匹配背景库，无匹配项时按场景生成新背景，并由视觉模型生成名称和描述供后续匹配
- **背景库**：支持文件夹、批量操作、会话与全局分层，可固定背景以免被场景指令替换
- **出图服务**：OpenAI 兼容接口（含 gpt-image、Gemini 图片模型）、ComfyUI 自定义工作流、OpenRouter、A1111 / Forge；每个配置组可单独指定出图后端与风格

<div align="center">
<img src=".github/assets/npc-temporary-sprites.jpg" alt="NPC 临时立绘" width="900">
<br><sub>剧情中出现的 NPC 没有角色卡时，自动生成透明背景的临时立绘，仅在当前会话中使用</sub>
</div>

<div align="center">
<img src=".github/assets/background-library-auto-generated.jpg" alt="背景库：按场景自动生成的背景" width="900">
<br><sub>背景库中的图片均在跑团过程中按场景自动生成并命名，顶部显示当前舞台使用的背景</sub>
</div>

### 🗣️ 多角色语音与语气演绎

- **九种语音引擎**：浏览器语音、Edge、OpenAI 兼容接口、ElevenLabs、Fish Audio、MiniMax、火山引擎、GPT-SoVITS、CosyVoice（官方接口或兼容网关）；Fish Audio 与 CosyVoice 网关支持拉取用户保存或收藏的音色
- **音色分配**：可按角色卡、群聊成员、NPC 分别指定音色；未指定时从音色池中**按性别**自动分配，性别可根据角色卡推断
- **语气演绎**：支持情绪、强度、耳语 / 喊叫、停顿，以及笑声、叹息、喘息、抽泣等十五种声音，按各引擎的支持方式转换（ElevenLabs 音频标签、Fish 情绪标记、CosyVoice 指令、MiniMax 语气词等）；引擎不支持的标记会被移除，不会被朗读
- **演绎导演**：模型未标注语气时，可由演绎导演根据上下文为每句台词补充语气
- **朗读方式**：支持手动朗读、新回复自动朗读、VN 逐句配音与边生成边朗读；群聊回复按顺序朗读；移动端浏览器拦截自动播放时会提示用户轻触恢复

### 🎲 规则可信的跑团支持

- 人设与角色卡支持 D&D 5e 属性卡（六维属性、熟练、专精、豁免、HP、AC），导出角色卡时一并写入
- 模型通过工具调用发起掷骰与属性 / 技能检定，结果以骰子卡片展示；**带检定的选项由 NoBot 先行掷骰后再发送**，模型只能沿用结果
- `<combat>` 指令开启战斗，VN 顶部显示先攻条与 HP
- 所有状态随消息树记录，重新生成或切换分支时，HP 与背包会回到对应节点的状态

<table>
<tr>
<td width="50%"><img src=".github/assets/trpg-skill-check-roll.jpg" alt="选项检定的掷骰演出"></td>
<td width="50%"><img src=".github/assets/trpg-critical-failure-scene.jpg" alt="检定大失败后的剧情走向"></td>
</tr>
<tr>
<td align="center"><sub>选择带检定的选项后，由 NoBot 掷骰并在画面中央演出结果（此处为求生检定大失败）</sub></td>
<td align="center"><sub>模型必须接受这一结果：下一段剧情转入战术失误后的攻城战，场景与背景随之切换</sub></td>
</tr>
</table>

<div align="center">
<img src=".github/assets/trpg-status-panel.jpg" alt="D&D 状态面板" width="900">
<br><sub>跑团状态面板：属性、HP、护甲等级、背包、金币与所在地点</sub>
</div>

### 🌳 可靠的对话管理

- **消息树**：支持重新生成、切换候选回复、编辑、删除（连同后续分支），以及从任意消息创建新会话；调整消息顺序时生成新分支并保留原顺序
- **生成不中断**：生成任务在服务端执行，刷新页面、切换会话或网络重连后回复继续显示
- **长对话性能**：消息列表采用虚拟滚动，按需加载更早的记录

## SillyTavern 兼容与通用功能

<details>
<summary><b>📚 SillyTavern 数据兼容</b></summary>

- 支持导入角色卡（PNG / JSON）、世界书、生成预设、立绘包与快速回复；导出的角色卡可在 SillyTavern 中使用
- 覆盖 SillyTavern 全部 Chat Completion 来源：Claude / Gemini / Vertex AI / Azure 使用原生协议，另有三十余家服务预置地址，并自动处理各家接口差异
- 采样参数、Prompt 管理器（拖动排序、按深度插入、按生成类型触发）、辅助提示词、消息后处理、续写与回复预填充
- 世界书：关键词（支持正则）、可选过滤、常驻、概率、递归、包含组、延迟 / 粘滞 / 冷却、角色过滤、Outlet、向量匹配，支持八种插入位置，可挂载到全局、角色、人设或会话

</details>

<details>
<summary><b>💬 聊天</b></summary>

- 流式输出、思考过程展示、中止生成、续写、代写，输入框为空时回车可让角色继续发言
- 群聊支持自然、列表、轮流、手动四种发言顺序，支持点名发言与静音成员
- 每个会话可单独设置人设、生成预设、连接、会话世界书、语音与作者注释
- 排除消息、书签、多选批量操作、斜杠命令（`/roll 2d6`、`/bg`、`/imagine` 等，可用 `|` 串联）与快速回复按钮
- 支持向视觉模型发送图片；模型不支持图片时可自动转为文字描述
- 翻译（模型、Google、DeepL、DeepLX、LibreTranslate、Lingva），保留原文，舞台指令在翻译后仍然生效
- 剧情总结、回收站、多人设，以及可从任意消息跳转的请求日志

</details>

<details>
<summary><b>🏠 部署与多用户</b></summary>

- 支持单进程运行或通过 `docker compose` 部署，兼容移动端浏览器
- 多用户：管理员可在「设置 → 账号 → 用户管理」中创建用户、重置密码、禁用或删除账号；各用户的角色、会话与 API Key 相互隔离
- 配置组：将连接、模型、生成预设、正则与图片设置组合保存，可设为默认、绑定到角色或在会话中切换
- 扩展：后端可注册宏、工具、斜杠命令与接口并参与 Prompt 组装，前端可向界面插槽添加组件；示例见 `examples/extensions/hello-world`
- 界面支持中文与英文

</details>

## 快速开始

需要 [Bun](https://bun.sh) 1.4 及以上版本（macOS：`brew install oven-sh/bun/bun`）。

```bash
bun install
NOBOT_ADMIN_PASSWORD='至少8位的密码' bun run dev   # 首次启动时创建管理员账号 admin
```

在浏览器中打开 <http://localhost:5173>，使用 `admin` 与上述密码登录。管理员创建后，后续直接运行 `bun run dev` 即可；如需其他管理员用户名，可设置 `NOBOT_ADMIN_USERNAME`。

登录后按左侧导航依次配置：

1. **连接**：选择服务提供方，填写 API Key，测试连接并拉取模型列表
2. **人设**：设置用户在故事中的名字（对应角色卡中的 `{{user}}`）
3. **角色**：导入 SillyTavern 角色卡，卡内附带的世界书会一并导入
4. **聊天**：新建会话，将玩法预设设为 Galgame 或 RPG，在右上角切换到 VN 模式

### 生产模式

```bash
bun run build   # 构建前端，代码更新后执行一次
bun start       # 单进程运行，访问 http://127.0.0.1:3000
```

局域网内的移动设备访问：运行 `HOST=0.0.0.0 bun start`，然后访问 `http://<电脑的局域网 IP>:3000`。如需公网访问，请在前面部署 HTTPS 反向代理（Nginx、Caddy 等），不要直接暴露 3000 端口。

### Docker 部署

```bash
echo "NOBOT_ADMIN_PASSWORD=至少8位的密码" > .env
docker compose up -d --build
```

默认仅监听本机 `127.0.0.1:3000`，数据挂载在 `./data`。更新时拉取新代码后再次执行 `docker compose up -d --build`。

<details>
<summary>常用 <code>.env</code> 变量</summary>

| 变量 | 说明 |
|---|---|
| `NOBOT_ADMIN_USERNAME` / `NOBOT_ADMIN_PASSWORD` | 首次启动时创建的管理员；创建成功后可移除密码变量 |
| `NOBOT_ADMIN_RESET=1` | 忘记密码时临时启用，配合新密码重启一次，恢复后改回 `0` |
| `NOBOT_BIND_IP` / `NOBOT_PORT` | 宿主机监听地址与端口，例如 `0.0.0.0` / `8080` |
| `TRUST_PROXY=1` | 仅在受信任的反向代理后启用，使登录限流识别真实客户端 IP |
| `NOBOT_PROXY` / `NOBOT_NO_PROXY` | 出站请求（模型、语音、图片接口）使用的代理 |
| `BUN_IMAGE` / `DEBIAN_MIRROR` / `BUILDKIT_SYNTAX` | 构建时无法访问 Docker Hub 或 Debian 源时使用的镜像地址 |

</details>

## 数据存储

```
data/system.db          账号与登录会话
data/users/<用户名>/     各用户的数据库、素材、语音缓存与扩展
data/models/            所有用户共用的模型文件（如抠图模型）
```

备份时停止服务并复制整个 `data/` 目录即可；可通过 `DATA_DIR` 指定其他存储位置。从单用户旧版本升级时，首次启动会自动将原有数据迁移到管理员账号下。

## 尚未支持

- 群聊自动模式（角色之间自动接续对话）、导入 SillyTavern 聊天记录、视频生成
- 其他跑团规则系统（COC、PF2e、PbtA、自定义规则）
- SillyTavern 的 Text Completion 模式（Instruct 模板与原始补全接口）

## 开发

```bash
bun test              # 运行全部测试
bun run typecheck     # 类型检查
bun run lint          # Biome 检查
bun run db:generate   # 修改 apps/server/src/db/schema.ts 后生成迁移
bun scripts/mock-llm.ts  # 模拟模型（端口 3999；连接地址 http://127.0.0.1:3999/v1，Key 为 sk-test），用于本地调试
```

无法监听端口或不希望联网时，可启用 mock 开关运行测试：

```bash
MOCK_LLM_FETCH=1 EXT2_FETCH_MOCK=1 IMG3_FETCH_MOCK=1 BACKGROUND_FETCH_MOCK=1 TTS_FETCH_MOCK=1 bun test
```

```
packages/shared   前后端共用的类型与 Zod 校验规则（接口契约）
packages/core     纯逻辑：Prompt 组装、世界书、宏、消息树、VN 舞台指令、语音演绎
apps/server       Bun + Hono 后端：账号、数据库、接口（见 apps/server/API.md）、生成任务、扩展
apps/web          React 19 前端
```

`fixtures/` 目录提供示例角色卡、世界书与生成预设。

## 许可证

[GNU AGPL-3.0](LICENSE)。允许自由使用、修改与分发；若将修改后的版本作为网络服务提供给他人使用，须公开相应源代码。

本项目与 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 无隶属关系，仅兼容其数据格式并参考了其功能设计。
