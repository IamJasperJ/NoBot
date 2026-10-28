import { useState } from 'react'
import type {
  ChannelAccountDTO,
  ChannelBindingDTO,
  ChannelCapabilityState,
  ChannelProvider,
  ChannelSettings,
  ChannelSettingsOverride,
} from '../../api/channels'
import { HintButton, Toggle } from '../../components/form'
import { RefreshIcon } from '../../components/icons'
import { badgeClass, controlClass, cx, IconButton, selectClass } from '../../components/ui'
import { t } from '../../i18n'

export const providerLabel = (p: ChannelAccountDTO['provider']) => (p === 'telegram' ? 'Telegram' : t('QQ（NapCat）'))

export const statusMeta = (s: ChannelAccountDTO['status']) =>
  ({
    online: { label: t('在线'), dot: 'bg-emerald-500' },
    connecting: { label: t('连接中'), dot: 'bg-amber-500' },
    error: { label: t('出错'), dot: 'bg-red-500' },
    stopped: { label: t('已停止'), dot: 'bg-zinc-400' },
  })[s]

export const capabilityLabel = (s: ChannelCapabilityState | undefined) =>
  s === 'supported'
    ? null
    : s === 'console_only'
      ? t('需在平台后台修改')
      : s === 'permission_required'
        ? t('需要群管理权限')
        : s === 'unsupported'
          ? t('平台不支持')
          : t('未确认')

export const scopeLabel = (b: ChannelBindingDTO) => (b.scope === 'private' ? t('私聊') : b.thread ? t('话题') : t('群'))

export const isolationLabel = (v: ChannelBindingDTO['isolation']) =>
  ({ dm: t('私聊'), shared: t('群共享'), 'per-user': t('每人各自'), 'per-topic': t('按话题') })[v]

export const stateMeta = (v: ChannelBindingDTO['state']) =>
  ({
    active: { label: t('使用中'), cls: 'text-emerald-600 dark:text-emerald-400' },
    pending: { label: t('待批准'), cls: 'text-amber-600 dark:text-amber-400' },
    disabled: { label: t('已停用'), cls: 'text-zinc-500' },
    left: { label: t('已退出'), cls: 'text-zinc-500' },
  })[v]

export const triggerOptions = () =>
  [
    { value: 'follow-room', label: t('跟随房间回合方式') },
    { value: 'mention', label: t('被 @ 时') },
    { value: 'reply', label: t('回复它的消息时') },
    { value: 'command', label: t('只响应命令') },
    { value: 'all', label: t('每条消息') },
  ] as const

export const personaModeOptions = () =>
  [
    { value: 'platform-name', label: t('用平台昵称') },
    { value: 'global', label: t('所有人共用一个人设') },
    { value: 'per-actor', label: t('每人自己选（/persona）') },
    { value: 'owner-assigned', label: t('由我指定') },
  ] as const

type Kind =
  | { type: 'bool' }
  | { type: 'select'; options: { value: string; label: string }[] }
  | { type: 'number'; min: number; max: number }
type Row = { key: keyof ChannelSettings; label: string; kind: Kind }

/** 只在某个平台有意义的设置；不在表里的两边都显示 */
const onlyFor: Partial<Record<keyof ChannelSettings, ChannelProvider>> = {
  stream: 'telegram',
  streamIntervalMs: 'telegram',
  regenerateButton: 'telegram',
  previousButton: 'telegram',
  nextButton: 'telegram',
  continueButton: 'telegram',
  deleteButton: 'telegram',
  miniAppMenuButton: 'telegram',
  miniAppButton: 'telegram',
  diceAnimation: 'telegram',
  multiSpeaker: 'onebot11',
  groupCard: 'onebot11',
  onlineStatus: 'onebot11',
  controlsFooter: 'onebot11',
  tempSessionDm: 'onebot11',
  maxMessageLength: 'onebot11',
  pokeBack: 'onebot11',
  pokeToStory: 'onebot11',
  dailySign: 'onebot11',
  socialCooldownMs: 'onebot11',
  socialDailyBudget: 'onebot11',
  stickerMaxSets: 'telegram',
  stickerAutoLabel: 'onebot11',
}

/** 设置项的悬停说明：只给字面意思不够清楚的项写；provider 用来区分 Telegram / QQ 的说法 */
const rowHint = (key: keyof ChannelSettings, provider?: ChannelProvider | 'shared'): string | undefined => {
  const qq = provider === 'onebot11'
  const map: Partial<Record<keyof ChannelSettings, string>> = {
    stream: t('边生成边更新消息：私聊用打字草稿，群里定时编辑同一条消息；关掉则生成完一次性发出'),
    streamIntervalMs: t('流式输出时多久编辑一次消息；太快可能触发平台限流'),
    thinking: t('模型的思考过程（推理内容）要不要发到平台上；折叠显示时用可展开的引用块'),
    queueMode: t(
      '角色还在回复时又有人发消息：排队合并会等这条回完，再把新消息一起回复；打断重来会停掉当前回复，带上新消息重新生成',
    ),
    regenerateButton: t('⟲ 按钮：重新生成这条回复'),
    previousButton: t('◀ 按钮：切回上一个备选回复'),
    nextButton: t('▶ 按钮：切到下一个备选回复，没有就生成一个新的'),
    continueButton: t('➕ 按钮：接着这条回复往下写'),
    deleteButton: t('🗑 按钮：删掉这条回复'),
    voice: qq
      ? t(
          '角色的回复要不要读成语音（用角色在音频扩展里设的声音）。「发 /speak 才读」：回复后发 /speak 读最近一条；「让角色自己决定」：角色觉得合适或被要求时才发语音',
        )
      : t(
          '角色的回复要不要读成语音（用角色在音频扩展里设的声音）。「点 🔊 才读」：消息下方有朗读按钮；「让角色自己决定」：角色觉得合适或被要求时才发语音',
        ),
    voiceDecideBias: t(
      '只在「让角色自己决定」时有效：少＝基本只在被要求时发，多＝气氛合适就发。聊天里说「多发语音 / 别发语音」也会改变它',
    ),
    voiceDecideStyle: t('只在「让角色自己决定」时有效：决定发语音的那条回复，是只发语音，还是文字和语音都发'),
    voiceDecideHourlyMax: t('每个群 / 私聊每小时最多发几条语音，超过后改发文字；0 为不限'),
    voiceNarration: t('只发语音时，回复里的旁白（动作、环境描写）怎么处理：发成短文字、一起读出来，或者直接不发'),
    voiceLongText: t('回复超过「一条语音最多读几个字」时：拆成几条语音，或这一条改发文字'),
    voiceMaxChars: t('一条语音最多读多少字，超过按上一项处理'),
    voiceInput: t('用户在平台上发语音时，用音频扩展的语音识别转成文字交给角色'),
    echoTranscript: t('把识别出的文字回复给发语音的人，方便确认听没听错'),
    cg: t('回复里带 <cg> 舞台指令时生成的 CG 图；打码发送会加剧透遮罩，点开才看得到'),
    generatedImages: t('角色调用画图工具或 /imagine 生成的图片；打码发送会加剧透遮罩。/imagine 总会发送'),
    sprites: t('VN 模式下角色的立绘图片：只在出场和换表情时发，或者每条回复都发'),
    background: t('VN 模式下场景变化时，把新的背景图发出来'),
    statusCard: t('角色状态（好感度、属性等状态栏）变化时发一张卡片；置顶则只保留一条置顶消息并原地更新'),
    diceAnimation: t('掷骰时先发 Telegram 自带的 🎲 动画骰子，再给出结果'),
    miniAppMenuButton: t('私聊输入框旁的菜单按钮改成打开 VN 舞台（Mini App），需要先在「基本」里配好公开地址'),
    miniAppButton: t('每条回复下方加一个 📖 按钮，点开在 Mini App 里看这一段的 VN 舞台'),
    multiSpeaker: t('群聊里一条回复有多个角色说话：每段前加「名字：」，或打包成合并转发，每个角色一条'),
    groupCard: t('bot 在群里的群名片自动改成当前扮演的角色名'),
    onlineStatus: t('生成回复时把 QQ 在线状态切成忙碌，回完再切回来'),
    controlsFooter: t('QQ 没有按钮，在每条回复末尾加一行「回复 /regen 重来，/swipe 换一个」'),
    tempSessionDm: t('私密内容（悄悄话、暗骰结果）要私发时，对方不是 bot 好友也通过群临时会话发过去'),
    maxMessageLength: t('超过这个字数的回复会拆成几条发送'),
    pokeBack: t('有人戳一戳 bot 时，bot 也戳回去'),
    pokeToStory: t('把「某某戳了戳你」写进聊天记录，让角色对此做出反应'),
    dailySign: t('bot 每天在活跃的群里自动群签到一次（当天群里第一次有人说话时）'),
    socialCooldownMs: t('戳回去、签到这类轻互动两次之间至少隔多久'),
    socialDailyBudget: t('轻互动每天最多做几次；0 为不限'),
    mirrorWebMessages: t('你在 NoBot 网页里对同一个聊天发的消息和角色回复，也同步发到平台上'),
    personaPrefix: t(
      '群聊里有多个角色、由这个 bot 代发时，在回复前加「角色名：」；网页同步过去的消息前加你的人设名。单角色聊天不会加',
    ),
    deleteSync: t('在 NoBot 里删掉消息（或删掉某个回复）时，把已经发到平台上的那几条也撤回'),
    mentionOnTurn: t('跑团轮流行动时，轮到谁就在群里 @ 谁'),
    actorRateLimit: t('防刷屏：同一个人一分钟内超过这么多条，多出的消息不会让角色回复'),
    reactions: qq
      ? t('角色偶尔给别人的消息贴一个表情回应（贴表情）')
      : t('角色偶尔给别人的消息点一个表情回应（Reaction）'),
    reactionCooldownMs: t('两次表情回应之间至少隔多久'),
    reactionDailyBudget: t('表情回应每天最多几次；0 为不限'),
    stickerFrequency: t('角色在回复里发表情包的频率；表情包在「表情包」页签管理'),
    stickerCooldownSec: t('同一个群 / 私聊里两次发表情包至少隔多少秒'),
    stickerAutoLearn: qq
      ? t('别人在群里或私聊发的表情会被记下来，之后角色也能用（只记引用，不存图片）')
      : t('别人发的贴纸会被记下来，并自动收录它所在的整个贴纸包（只记引用，不存图片）'),
    stickerMaxSets: t('自动学习最多收录多少个贴纸包，满了就不再新增'),
    stickerAutoLabel: t('bot 收藏的表情没有文字含义，开启后用识图模型看一次，写几个关键词，角色才知道什么时候用'),
  }
  return map[key]
}

/** 行为设置分组；每层（全局 → 机器人 → 位置）都用同一份清单 */
/** provider 用来换掉只适用于某个平台的选项文字（QQ 没有按钮） */
export const settingGroups = (provider?: ChannelProvider | 'shared'): { title: string; rows: Row[] }[] => [
  {
    title: t('输出'),
    rows: [
      { key: 'stream', label: t('流式输出'), kind: { type: 'bool' } },
      { key: 'streamIntervalMs', label: t('更新间隔（毫秒）'), kind: { type: 'number', min: 250, max: 60000 } },
      {
        key: 'thinking',
        label: t('思考过程'),
        kind: {
          type: 'select',
          options: [
            { value: 'omit', label: t('不发') },
            { value: 'fold', label: t('折叠显示') },
          ],
        },
      },
      {
        key: 'queueMode',
        label: t('生成中又收到消息'),
        kind: {
          type: 'select',
          options: [
            { value: 'merge', label: t('排队合并') },
            { value: 'interrupt', label: t('打断重来') },
          ],
        },
      },
    ],
  },
  {
    title: t('消息下方的按钮'),
    rows: [
      { key: 'regenerateButton', label: t('重新生成'), kind: { type: 'bool' } },
      { key: 'previousButton', label: t('上一个回复'), kind: { type: 'bool' } },
      { key: 'nextButton', label: t('下一个回复'), kind: { type: 'bool' } },
      { key: 'continueButton', label: t('续写'), kind: { type: 'bool' } },
      { key: 'deleteButton', label: t('删除'), kind: { type: 'bool' } },
    ],
  },
  {
    title: t('语音'),
    rows: [
      {
        key: 'voice',
        label: t('角色语音'),
        kind: {
          type: 'select',
          options: [
            {
              value: 'button',
              label:
                provider === 'onebot11'
                  ? t('发 /speak 才读')
                  : provider === 'telegram'
                    ? t('点 🔊 才读')
                    : t('点 🔊 或发 /speak 才读'),
            },
            { value: 'auto', label: t('文字 + 语音') },
            { value: 'only', label: t('只发语音') },
            { value: 'decide', label: t('让角色自己决定') },
            { value: 'off', label: t('不读') },
          ],
        },
      },
      {
        key: 'voiceDecideBias',
        label: t('角色决定时，多常发语音'),
        kind: {
          type: 'select',
          options: [
            { value: 'low', label: t('少，被要求才发') },
            { value: 'medium', label: t('适中') },
            { value: 'high', label: t('多，合适就发') },
          ],
        },
      },
      {
        key: 'voiceDecideStyle',
        label: t('角色决定发语音时'),
        kind: {
          type: 'select',
          options: [
            { value: 'only', label: t('只发语音') },
            { value: 'with-text', label: t('文字 + 语音') },
          ],
        },
      },
      {
        key: 'voiceDecideHourlyMax',
        label: t('每小时最多几条语音（0 为不限）'),
        kind: { type: 'number', min: 0, max: 1000 },
      },
      {
        key: 'voiceNarration',
        label: t('只发语音时，旁白'),
        kind: {
          type: 'select',
          options: [
            { value: 'text', label: t('发成短文字') },
            { value: 'speak', label: t('一起读出来') },
            { value: 'drop', label: t('不发') },
          ],
        },
      },
      {
        key: 'voiceLongText',
        label: t('只发语音时，太长的回复'),
        kind: {
          type: 'select',
          options: [
            { value: 'split', label: t('拆成几条语音') },
            { value: 'text', label: t('改发文字') },
          ],
        },
      },
      { key: 'voiceMaxChars', label: t('一条语音最多读几个字'), kind: { type: 'number', min: 1, max: 4500 } },
      { key: 'voiceInput', label: t('把用户的语音转成文字'), kind: { type: 'bool' } },
      { key: 'echoTranscript', label: t('把识别出的文字发回来'), kind: { type: 'bool' } },
    ],
  },
  {
    title: t('图片'),
    rows: [
      {
        key: 'cg',
        label: t('CG'),
        kind: {
          type: 'select',
          options: [
            { value: 'send', label: t('发送') },
            { value: 'spoiler', label: t('打码发送') },
            { value: 'off', label: t('不发') },
          ],
        },
      },
      {
        key: 'generatedImages',
        label: t('生成的图片'),
        kind: {
          type: 'select',
          options: [
            { value: 'send', label: t('发送') },
            { value: 'spoiler', label: t('打码发送') },
            { value: 'off', label: t('不发') },
          ],
        },
      },
      {
        key: 'sprites',
        label: t('立绘'),
        kind: {
          type: 'select',
          options: [
            { value: 'off', label: t('不发') },
            { value: 'changes', label: t('出场和换表情时') },
            { value: 'every', label: t('每条都发') },
          ],
        },
      },
      { key: 'background', label: t('换场景时发背景图'), kind: { type: 'bool' } },
      {
        key: 'statusCard',
        label: t('状态卡'),
        kind: {
          type: 'select',
          options: [
            { value: 'off', label: t('不发') },
            { value: 'every', label: t('变化时发') },
            { value: 'pinned', label: t('置顶并原地更新') },
          ],
        },
      },
      { key: 'diceAnimation', label: t('掷骰时加 🎲 动画'), kind: { type: 'bool' } },
    ],
  },
  {
    title: t('VN 舞台（Mini App）'),
    rows: [
      { key: 'miniAppMenuButton', label: t('私聊菜单按钮打开舞台'), kind: { type: 'bool' } },
      { key: 'miniAppButton', label: t('消息下方加 📖 按钮'), kind: { type: 'bool' } },
    ],
  },
  {
    title: t('QQ 专用'),
    rows: [
      {
        key: 'multiSpeaker',
        label: t('多个角色说话时'),
        kind: {
          type: 'select',
          options: [
            { value: 'prefix', label: t('每段前加名字') },
            { value: 'forward', label: t('合并转发（每个角色一条）') },
          ],
        },
      },
      { key: 'groupCard', label: t('群名片跟随扮演的角色'), kind: { type: 'bool' } },
      {
        key: 'onlineStatus',
        label: t('在线状态'),
        kind: {
          type: 'select',
          options: [
            { value: 'off', label: t('不管理') },
            { value: 'follow', label: t('跟随状态（生成中显示忙碌）') },
          ],
        },
      },
      { key: 'controlsFooter', label: t('回复末尾提示可用命令'), kind: { type: 'bool' } },
      { key: 'tempSessionDm', label: t('私密内容可用临时会话发给非好友'), kind: { type: 'bool' } },
      { key: 'maxMessageLength', label: t('单条消息最长字数'), kind: { type: 'number', min: 100, max: 4500 } },
    ],
  },
  {
    title: t('QQ 轻互动'),
    rows: [
      { key: 'pokeBack', label: t('被戳时戳回去'), kind: { type: 'bool' } },
      { key: 'pokeToStory', label: t('被戳写进剧情'), kind: { type: 'bool' } },
      { key: 'dailySign', label: t('每天群签到'), kind: { type: 'bool' } },
      { key: 'socialCooldownMs', label: t('冷却（毫秒）'), kind: { type: 'number', min: 1000, max: 3600000 } },
      { key: 'socialDailyBudget', label: t('每天最多次数（0 为不限）'), kind: { type: 'number', min: 0, max: 1000 } },
    ],
  },
  {
    title: t('同步与提醒'),
    rows: [
      { key: 'mirrorWebMessages', label: t('网页上发的消息同步到平台'), kind: { type: 'bool' } },
      { key: 'personaPrefix', label: t('消息前加说话人名字'), kind: { type: 'bool' } },
      { key: 'deleteSync', label: t('在 NoBot 删消息时也撤回平台上的'), kind: { type: 'bool' } },
      { key: 'mentionOnTurn', label: t('轮到某人时在群里 @ 他'), kind: { type: 'bool' } },
      { key: 'actorRateLimit', label: t('每人每分钟最多消息数'), kind: { type: 'number', min: 1, max: 1000 } },
    ],
  },
  {
    title: t('轻互动'),
    rows: [
      { key: 'reactions', label: t('角色给消息回表情'), kind: { type: 'bool' } },
      { key: 'reactionCooldownMs', label: t('冷却（毫秒）'), kind: { type: 'number', min: 1000, max: 3600000 } },
      { key: 'reactionDailyBudget', label: t('每天最多次数（0 为不限）'), kind: { type: 'number', min: 0, max: 1000 } },
    ],
  },
  {
    title: t('表情包'),
    rows: [
      {
        key: 'stickerFrequency',
        label: t('角色发表情包'),
        kind: {
          type: 'select',
          options: [
            { value: 'rarely', label: t('偶尔') },
            { value: 'sometimes', label: t('有时') },
            { value: 'often', label: t('经常') },
            { value: 'off', label: t('不发') },
          ],
        },
      },
      { key: 'stickerCooldownSec', label: t('两次之间至少隔几秒'), kind: { type: 'number', min: 0, max: 86400 } },
      { key: 'stickerAutoLearn', label: t('记住聊天里别人发的表情'), kind: { type: 'bool' } },
      { key: 'stickerMaxSets', label: t('最多自动收录几个贴纸包'), kind: { type: 'number', min: 0, max: 300 } },
      { key: 'stickerAutoLabel', label: t('用识图模型给收藏表情写含义'), kind: { type: 'bool' } },
    ],
  },
]

const sourceLabel = (s: 'global' | 'account' | 'binding') =>
  s === 'global' ? t('继承全局') : s === 'account' ? t('继承机器人') : t('本处设置')

/**
 * 分层设置编辑器：没覆盖的项显示继承来的值（灰色徽标标明来源），改了就写进本层；↺ 清除本层覆盖。
 */
export function OverrideEditor({
  value,
  effective,
  inheritedFrom,
  onChange,
  disabled,
  provider,
  only,
  plain,
}: {
  /** 只显示这个平台用得上的项（平台专用 + 通用）；不传时全部显示 */
  provider?: ChannelProvider
  /** 全局默认页按页签拆分：'shared' 只显示两边共用的项，平台名只显示该平台专用的项 */
  only?: 'shared' | ChannelProvider
  /** 全局默认：value 就是完整设置，没有继承徽标和恢复按钮 */
  plain?: boolean
  /** 本层的覆盖值 */
  value: ChannelSettingsOverride
  /** 没覆盖时显示的值 */
  effective: ChannelSettings
  /** 没覆盖时值的来源 */
  inheritedFrom: (key: keyof ChannelSettings) => 'global' | 'account' | 'binding'
  onChange: (next: ChannelSettingsOverride) => void
  disabled?: boolean
}) {
  const set = (key: keyof ChannelSettings, v: unknown) => onChange({ ...value, [key]: v })
  // 点 ⓘ 展开的说明（悬停也能看到），和扩展设置页的写法一致
  const [openHints, setOpenHints] = useState<Set<string>>(() => new Set())
  const toggleHint = (key: string) =>
    setOpenHints((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })
  const reset = (key: keyof ChannelSettings) => {
    const next = { ...value }
    delete next[key]
    onChange(next)
  }
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {settingGroups(provider ?? only)
        .map((group) => ({
          ...group,
          rows: group.rows.filter(
            (row) =>
              (!provider || !onlyFor[row.key] || onlyFor[row.key] === provider) &&
              (!only || (only === 'shared' ? !onlyFor[row.key] : onlyFor[row.key] === only)) &&
              // 识别文字回显的默认值按私聊 / 群聊区分，全局层不提供
              !(plain && row.key === 'echoTranscript'),
          ),
        }))
        .filter((group) => group.rows.length > 0)
        .map((group) => (
          <section
            key={group.title}
            className="rounded-xl border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/40"
          >
            <h4 className="pb-1 text-xs font-medium text-zinc-500">{group.title}</h4>
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {group.rows.map((row) => {
                const own = plain || value[row.key] !== undefined
                const current = (own ? value[row.key] : effective[row.key]) as boolean | number | string
                const hint = rowHint(row.key, provider ?? only)
                return (
                  <li key={row.key} className="py-1.5">
                    <div className="flex min-h-8 items-center gap-2">
                      <span className="flex min-w-0 flex-1 items-center gap-0.5 text-[13px]">
                        {row.label}
                        {hint && (
                          <HintButton hint={hint} open={openHints.has(row.key)} onToggle={() => toggleHint(row.key)} />
                        )}
                      </span>
                      {plain ? null : own ? (
                        <IconButton label={t('恢复继承')} onClick={() => reset(row.key)} disabled={disabled}>
                          <RefreshIcon />
                        </IconButton>
                      ) : (
                        <span className={cx(badgeClass, 'font-normal text-zinc-400')}>
                          {sourceLabel(inheritedFrom(row.key))}
                        </span>
                      )}
                      <div className={cx('shrink-0', !own && 'opacity-60')}>
                        {row.kind.type === 'bool' ? (
                          <Toggle
                            label={row.label}
                            checked={current as boolean}
                            disabled={disabled}
                            onChange={(v) => set(row.key, v)}
                          />
                        ) : row.kind.type === 'select' ? (
                          <select
                            aria-label={row.label}
                            className={cx(selectClass, 'w-32')}
                            value={current as string}
                            disabled={disabled}
                            onChange={(e) => set(row.key, e.target.value)}
                          >
                            {row.kind.options.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="number"
                            aria-label={row.label}
                            className={cx(controlClass, 'w-28')}
                            min={row.kind.min}
                            max={row.kind.max}
                            value={current as number}
                            disabled={disabled}
                            onChange={(e) => {
                              const kind = row.kind as { min: number; max: number }
                              const n = Number(e.target.value)
                              if (Number.isFinite(n))
                                set(row.key, Math.min(kind.max, Math.max(kind.min, Math.round(n))))
                            }}
                          />
                        )}
                      </div>
                    </div>
                    {hint && openHints.has(row.key) && (
                      <p className="pt-1 text-xs leading-relaxed text-zinc-500">{hint}</p>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
    </div>
  )
}

export const timeAgo = (at: number) => {
  const s = Math.max(0, (Date.now() - at) / 1000)
  if (s < 60) return t('刚刚')
  if (s < 3600) return t('{n} 分钟前', { n: Math.floor(s / 60) })
  if (s < 86400) return t('{n} 小时前', { n: Math.floor(s / 3600) })
  return t('{n} 天前', { n: Math.floor(s / 86400) })
}
