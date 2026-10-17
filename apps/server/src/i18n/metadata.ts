import type { ExtensionSettingField } from '@ai-parter/shared'
import { t } from '.'

/** 固定元数据延迟到返回 DTO 时翻译，避免模块初始化时锁定语言。未知的第三方文字保持原样。 */
export function translateMetadata(text: string): string {
  switch (text) {
    case '-1 为随机；生成新候选时固定种子也会重新随机':
      return t('-1 为随机；生成新候选时固定种子也会重新随机')
    case '0 表示不按 token 触发':
      return t('0 表示不按 token 触发')
    case '0 表示不按条数触发':
      return t('0 表示不按条数触发')
    case '0 表示不限，优先总结较早的消息':
      return t('0 表示不限，优先总结较早的消息')
    case '0 表示字数上限乘 2':
      return t('0 表示字数上限乘 2')
    case '0 表示继承':
      return t('0 表示继承')
    case '1088×1920（9:16，1080p 竖向壁纸）':
      return t('1088×1920（9:16，1080p 竖向壁纸）')
    case '1152×896（9:7，SDXL 横图）':
      return t('1152×896（9:7，SDXL 横图）')
    case '1216×832（19:13，SDXL 横图）':
      return t('1216×832（19:13，SDXL 横图）')
    case '1280×720（16:9，720p 横向壁纸）':
      return t('1280×720（16:9，720p 横向壁纸）')
    case '1344×768（7:4，SDXL 横图）':
      return t('1344×768（7:4，SDXL 横图）')
    case '1536×640（24:10，SDXL 横图）':
      return t('1536×640（24:10，SDXL 横图）')
    case '1920×1088（16:9，1080p 横向壁纸）':
      return t('1920×1088（16:9，1080p 横向壁纸）')
    case '512×512（1:1，图标/头像）':
      return t('512×512（1:1，图标/头像）')
    case '512×768（2:3，竖向角色卡）':
      return t('512×768（2:3，竖向角色卡）')
    case '540×960（9:16，竖向壁纸）':
      return t('540×960（9:16，竖向壁纸）')
    case '600×600（1:1，图标/头像）':
      return t('600×600（1:1，图标/头像）')
    case '640×1536（10:24，SDXL 竖图）':
      return t('640×1536（10:24，SDXL 竖图）')
    case '720×1280（9:16，720p 竖向壁纸）':
      return t('720×1280（9:16，720p 竖向壁纸）')
    case '768×1344（4:7，SDXL 竖图）':
      return t('768×1344（4:7，SDXL 竖图）')
    case '768×512（3:2，横向电影胶片）':
      return t('768×512（3:2，横向电影胶片）')
    case '832×1216（13:19，SDXL 竖图）':
      return t('832×1216（13:19，SDXL 竖图）')
    case '896×1152（7:9，SDXL 竖图）':
      return t('896×1152（7:9，SDXL 竖图）')
    case '960×540（16:9，横向壁纸）':
      return t('960×540（16:9，横向壁纸）')
    case 'API 密钥':
      return t('API 密钥')
    case 'CLIP 跳层':
      return t('CLIP 跳层')
    case 'ComfyUI 地址':
      return t('ComfyUI 地址')
    case 'GPT Image 质量':
      return t('GPT Image 质量')
    case 'OpenAI 兼容接口':
      return t('OpenAI 兼容接口')
    case '与工作流的 Loader 类型匹配':
      return t('与工作流的 Loader 类型匹配')
    case '中':
      return t('中')
    case '交互与工具':
      return t('交互与工具')
    case '交互模式':
      return t('交互模式')
    case '仅复用地址与密钥，不切换聊天连接或使用聊天模型':
      return t('仅复用地址与密钥，不切换聊天连接或使用聊天模型')
    case '仅规范空白，保留引号、前缀和结构化 JSON（给接受结构化提示词的 ComfyUI 工作流用）':
      return t('仅规范空白，保留引号、前缀和结构化 JSON（给接受结构化提示词的 ComfyUI 工作流用）')
    case '从聊天末尾倒数，0 表示末尾':
      return t('从聊天末尾倒数，0 表示末尾')
    case '低':
      return t('低')
    case '何时总结':
      return t('何时总结')
    case '作用于 AI 输出':
      return t('作用于 AI 输出')
    case '作用于用户输入':
      return t('作用于用户输入')
    case '作者注释位置':
      return t('作者注释位置')
    case '作者注释位置跟随会话的深度':
      return t('作者注释位置跟随会话的深度')
    case '例如反向代理鉴权，留空不附加；示例：{"Authorization": "Bearer xxx"}':
      return t('例如反向代理鉴权，留空不附加；示例：{"Authorization": "Bearer xxx"}')
    case '保留最近消息数':
      return t('保留最近消息数')
    case '允许模型调用 generate_image 工具':
      return t('允许模型调用 generate_image 工具')
    case '先插入占位框，完成后自动显示图片':
      return t('先插入占位框，完成后自动显示图片')
    case '关闭时仅使用角色设定和本次指令':
      return t('关闭时仅使用角色设定和本次指令')
    case '写提示词时带上聊天记录':
      return t('写提示词时带上聊天记录')
    case '写提示词的模型':
      return t('写提示词的模型')
    case '写提示词的连接':
      return t('写提示词的连接')
    case '前缀里可以写 {prompt} 指定生成提示词插入的位置':
      return t('前缀里可以写 {prompt} 指定生成提示词插入的位置')
    case '剧情总结':
      return t('剧情总结')
    case '助手':
      return t('助手')
    case '包含 /v1 等接口路径':
      return t('包含 /v1 等接口路径')
    case '匹配用户的中英文要图请求，和文字回复同时生成；开启工具调用时不生效':
      return t('匹配用户的中英文要图请求，和文字回复同时生成；开启工具调用时不生效')
    case '单次最多消息数':
      return t('单次最多消息数')
    case '即使已总结也保留这些消息作为衔接':
      return t('即使已总结也保留这些消息作为衔接')
    case '去噪强度':
      return t('去噪强度')
    case '只发聊天记录':
      return t('只发聊天记录')
    case '只改发送的 Prompt':
      return t('只改发送的 Prompt')
    case '可以从端点拉取全部模型（图片模型排在前面），也可以直接手填任意模型 ID':
      return t('可以从端点拉取全部模型（图片模型排在前面），也可以直接手填任意模型 ID')
    case '同时生成的最大数量':
      return t('同时生成的最大数量')
    case '名称':
      return t('名称')
    case '后端':
      return t('后端')
    case '启用':
      return t('启用')
    case '启用后覆盖风格的前缀、后缀和负面；宽高同时大于零时覆盖尺寸':
      return t('启用后覆盖风格的前缀、后缀和负面；宽高同时大于零时覆盖尺寸')
    case '回复长度上限':
      return t('回复长度上限')
    case '图片接口':
      return t('图片接口')
    case '图片接口 /images/generations（gpt-image、DALL·E）':
      return t('图片接口 /images/generations（gpt-image、DALL·E）')
    case '图片接口的鉴权密钥':
      return t('图片接口的鉴权密钥')
    case '图片模型':
      return t('图片模型')
    case '图片消息模板':
      return t('图片消息模板')
    case '图片生成':
      return t('图片生成')
    case '基准分辨率':
      return t('基准分辨率')
    case '复用连接':
      return t('复用连接')
    case '多模态描述头像':
      return t('多模态描述头像')
    case '字数上限':
      return t('字数上限')
    case '完整上下文':
      return t('完整上下文')
    case '宽度':
      return t('宽度')
    case '工作流':
      return t('工作流')
    case '工具':
      return t('工具')
    case '异步生成':
      return t('异步生成')
    case '当前场景':
      return t('当前场景')
    case '必须可由应用服务器访问':
      return t('必须可由应用服务器访问')
    case '怎么总结':
      return t('怎么总结')
    case '怎么用':
      return t('怎么用')
    case '总结指令':
      return t('总结指令')
    case '总结注入使用的消息角色':
      return t('总结注入使用的消息角色')
    case '指定消息':
      return t('指定消息')
    case '指定深度':
      return t('指定深度')
    case '按模型修正尺寸':
      return t('按模型修正尺寸')
    case '按生成类型覆盖':
      return t('按生成类型覆盖')
    case '按顺序执行。查找写成 /正则/标志 按正则匹配，否则按普通文本全部替换；替换里可用 $1 引用分组。':
      return t('按顺序执行。查找写成 /正则/标志 按正则匹配，否则按普通文本全部替换；替换里可用 $1 引用分组。')
    case '排除不希望出现的内容':
      return t('排除不希望出现的内容')
    case '接口地址':
      return t('接口地址')
    case '接口类型':
      return t('接口类型')
    case '提示词模板':
      return t('提示词模板')
    case '支持 {prompt} 指定角色外貌和生成提示词的插入位置':
      return t('支持 {prompt} 指定角色外貌和生成提示词的插入位置')
    case '支持 {{char}} {{user}} {{prompt}}；prompt 不含风格和角色前缀':
      return t('支持 {{char}} {{user}} {{prompt}}；prompt 不含风格和角色前缀')
    case '支持 {{words}} 字数上限':
      return t('支持 {{words}} 字数上限')
    case '放在生成提示词之后':
      return t('放在生成提示词之后')
    case '新内容 token 数':
      return t('新内容 token 数')
    case '新消息条数':
      return t('新消息条数')
    case '普通聊天':
      return t('普通聊天')
    case '替换为':
      return t('替换为')
    case '替换总结指令中的 {{words}}':
      return t('替换总结指令中的 {{words}}')
    case '最后一条消息':
      return t('最后一条消息')
    case '最后一条消息原文':
      return t('最后一条消息原文')
    case '最少处理提示词':
      return t('最少处理提示词')
    case '有的模型（比如 Gemini 图片模型）只能通过聊天接口出图，图片包含在回复里':
      return t('有的模型（比如 Gemini 图片模型）只能通过聊天接口出图，图片包含在回复里')
    case '查找':
      return t('查找')
    case '根据角色和聊天场景生成图片，支持 OpenAI 兼容接口与 ComfyUI。':
      return t('根据角色和聊天场景生成图片，支持 OpenAI 兼容接口与 ComfyUI。')
    case '模型':
      return t('模型')
    case '横竖图对调后，尽量保持像素总数并贴合最近的预设':
      return t('横竖图对调后，尽量保持像素总数并贴合最近的预设')
    case '正则替换':
      return t('正则替换')
    case '正向前缀':
      return t('正向前缀')
    case '正向后缀':
      return t('正向后缀')
    case '每个图片请求都会带上，例如反向代理鉴权；示例：{"X-Api-Key": "xxx"}':
      return t('每个图片请求都会带上，例如反向代理鉴权；示例：{"X-Api-Key": "xxx"}')
    case '沿消息分支增量总结剧情，可按需注入上下文。':
      return t('沿消息分支增量总结剧情，可按需注入上下文。')
    case '注入位置':
      return t('注入位置')
    case '注入模板':
      return t('注入模板')
    case '深度':
      return t('深度')
    case '生成前编辑提示词':
      return t('生成前编辑提示词')
    case '生成类型':
      return t('生成类型')
    case '生成结束后检查总结条件':
      return t('生成结束后检查总结条件')
    case '用 {{summary}} 插入最近的总结':
      return t('用 {{summary}} 插入最近的总结')
    case '用户':
      return t('用户')
    case '用户（人设）':
      return t('用户（人设）')
    case '用正则表达式改写用户输入、AI 输出或发送给模型的 Prompt。比如去掉多余的星号、统一引号。':
      return t('用正则表达式改写用户输入、AI 输出或发送给模型的 Prompt。比如去掉多余的星号、统一引号。')
    case '画面与分辨率':
      return t('画面与分辨率')
    case '留空使用工作流默认':
      return t('留空使用工作流默认')
    case '留空使用该连接的默认模型；跟随会话时请先选择会话':
      return t('留空使用该连接的默认模型；跟随会话时请先选择会话')
    case '留空使用连接的模型':
      return t('留空使用连接的模型')
    case '留空跟随会话连接':
      return t('留空跟随会话连接')
    case '确认完整正负提示词和参数后才提交图片任务':
      return t('确认完整正负提示词和参数后才提交图片任务')
    case '种子':
      return t('种子')
    case '系统':
      return t('系统')
    case '组装时省略总结范围内的旧消息':
      return t('组装时省略总结范围内的旧消息')
    case '编辑器里可以粘贴从 ComfyUI 导出的 API 格式工作流，并查看用到了哪些占位符':
      return t('编辑器里可以粘贴从 ComfyUI 导出的 API 格式工作流，并查看用到了哪些占位符')
    case '聊天接口 /chat/completions（Gemini 图片模型、nano-banana 等）':
      return t('聊天接口 /chat/completions（Gemini 图片模型、nano-banana 等）')
    case '背景':
      return t('背景')
    case '自动':
      return t('自动')
    case '自动总结':
      return t('自动总结')
    case '自动（按模型判断，失败时换另一个）':
      return t('自动（按模型判断，失败时换另一个）')
    case '自定义':
      return t('自定义')
    case '自定义（下面填写地址和密钥）':
      return t('自定义（下面填写地址和密钥）')
    case '自由描述':
      return t('自由描述')
    case '行为':
      return t('行为')
    case '要求输出英文关键词；支持 {{char}} {{user}} {{input}}，自由模式可写 {{charPrefix}}':
      return t('要求输出英文关键词；支持 {{char}} {{user}} {{input}}，自由模式可写 {{charPrefix}}')
    case '覆盖该类型的风格参数':
      return t('覆盖该类型的风格参数')
    case '规则':
      return t('规则')
    case '角色':
      return t('角色')
    case '角色、脸部和用户模式将头像发送给写提示词的模型，无头像时使用普通模板':
      return t('角色、脸部和用户模式将头像发送给写提示词的模型，无头像时使用普通模板')
    case '角色设定之后':
      return t('角色设定之后')
    case '角色（全身）':
      return t('角色（全身）')
    case '角色（脸部特写）':
      return t('角色（脸部特写）')
    case '让模型看到交互模式生成的图片消息':
      return t('让模型看到交互模式生成的图片消息')
    case '让模型看到工具生成的图片消息':
      return t('让模型看到工具生成的图片消息')
    case '让模型看到按钮生成的图片消息':
      return t('让模型看到按钮生成的图片消息')
    case '让聊天模型在需要时发起图片生成':
      return t('让聊天模型在需要时发起图片生成')
    case '请求方式':
      return t('请求方式')
    case '调度器':
      return t('调度器')
    case '调整后贴合预设分辨率':
      return t('调整后贴合预设分辨率')
    case '负面提示词':
      return t('负面提示词')
    case '超时（秒）':
      return t('超时（秒）')
    case '超过后中止当前任务':
      return t('超过后中止当前任务')
    case '超过的任务按顺序排队':
      return t('超过的任务按顺序排队')
    case '跟随会话':
      return t('跟随会话')
    case '跟随当前会话的连接':
      return t('跟随当前会话的连接')
    case '跳过已总结消息':
      return t('跳过已总结消息')
    case '连接':
      return t('连接')
    case '选了就随请求发送 quality；「自动」时不发送':
      return t('选了就随请求发送 quality；「自动」时不发送')
    case '选择发送的上下文范围':
      return t('选择发送的上下文范围')
    case '采样器':
      return t('采样器')
    case '采样步数':
      return t('采样步数')
    case '陪伴':
      return t('陪伴')
    case '额外参数（JSON）':
      return t('额外参数（JSON）')
    case '额外请求头':
      return t('额外请求头')
    case '额外请求头（JSON）':
      return t('额外请求头（JSON）')
    case '风格':
      return t('风格')
    case '高':
      return t('高')
    case '高度':
      return t('高度')
    case '高级接口参数，会合并到图片请求中':
      return t('高级接口参数，会合并到图片请求中')
    case '默认关闭；工具结果文字仍然进入上下文，图片说明照常保存':
      return t('默认关闭；工具结果文字仍然进入上下文，图片说明照常保存')
    case '默认原样发送设置的分辨率。开启后 gpt-image 贴合 1024×1024 / 1536×1024 / 1024×1536，DALL·E 贴合它支持的尺寸':
      return t(
        '默认原样发送设置的分辨率。开启后 gpt-image 贴合 1024×1024 / 1536×1024 / 1024×1536，DALL·E 贴合它支持的尺寸',
      )
    case '默认预设':
      return t('默认预设')
    case '主提示词':
      return t('主提示词')
    case '辅助提示词':
      return t('辅助提示词')
    case '增强定义':
      return t('增强定义')
    case '历史后指令':
      return t('历史后指令')
    case '世界书（角色前）':
      return t('世界书（角色前）')
    case '角色描述':
      return t('角色描述')
    case '角色性格':
      return t('角色性格')
    case '场景':
      return t('场景')
    case '世界书（角色后）':
      return t('世界书（角色后）')
    case '用户人设':
      return t('用户人设')
    case '示例对话':
      return t('示例对话')
    case '聊天记录':
      return t('聊天记录')
    case '必须且只能指定角色或群组之一':
      return t('必须且只能指定角色或群组之一')
    case '群聊至少要有一个成员':
      return t('群聊至少要有一个成员')
    default:
      return text
  }
}

/** 只处理描述性字段；选项值、条件、用户设置及提示词模板均不能翻译。 */
export function translateSettingsSchema(fields: ExtensionSettingField[]): ExtensionSettingField[] {
  return fields.map((field) => ({
    ...field,
    label: translateMetadata(field.label),
    ...(field.hint === undefined ? {} : { hint: translateMetadata(field.hint) }),
    ...(field.attachLabel === undefined ? {} : { attachLabel: translateMetadata(field.attachLabel) }),
    ...('placeholder' in field && field.placeholder !== undefined
      ? { placeholder: translateMetadata(field.placeholder) }
      : {}),
    ...(field.type === 'select'
      ? { options: field.options.map((option) => ({ ...option, label: translateMetadata(option.label) })) }
      : {}),
    ...(field.type === 'list' ? { itemFields: translateSettingsSchema(field.itemFields) } : {}),
  }))
}
