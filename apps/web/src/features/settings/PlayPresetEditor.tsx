import {
  DEFAULT_DIRECTIVE_REMINDERS,
  DEFAULT_DIRECTIVE_TEMPLATES,
  type DirectiveKind,
  EXPRESSIONS,
  IMPLEMENTED_RULE_SYSTEMS,
  type PlayPresetData,
  type PromptList,
  type RuleSystem,
  stateSchemaSchema,
} from '@ai-parter/shared'
import { useConnections } from '../../api/queries'
import {
  CheckGroupField,
  DenseRow,
  NumberField,
  Section,
  SelectField,
  SwitchField,
  TextAreaField,
  TextField,
} from '../../components/form'
import { TagInput } from '../../components/tags'
import { Button } from '../../components/ui'
import { t } from '../../i18n'
import { directiveKindLabels } from '../../i18n-labels'

/**
 * 玩法预设编辑器：设计稿（docs/design/vn-mode.md）第 11 节的全部设置项，按分组排成紧凑多列。
 * 还没实现的设置项照样可以改和保存，标「未实现」，说明里写明从哪一期开始生效。
 */

type Group = keyof PlayPresetData

const KIND_OPTIONS = () =>
  (Object.keys(directiveKindLabels()) as DirectiveKind[]).map((value) => ({
    value,
    label: directiveKindLabels()[value],
    // 第一期只处理表情、上下台、场景、变量、选项；其余种类先只隐藏不演出
    notImplemented: !['expression', 'cast', 'scene', 'state', 'choices', 'cg'].includes(value),
  }))

const LIST_OPTIONS = (): { value: PromptList; label: string }[] => [
  { value: 'cast', label: t('角色') },
  { value: 'expressions', label: t('表情') },
  { value: 'backgrounds', label: t('背景') },
  { value: 'outfits', label: t('服装') },
  { value: 'vars', label: t('变量') },
]

const RULE_LABELS = (): Record<RuleSystem, string> => ({
  dnd5e: 'D&D 5e',
  coc7: t('克苏鲁的呼唤 7 版'),
  pf2e: 'Pathfinder 2e',
  pbta: t('简易 2d6（PbtA）'),
  custom: t('自定义'),
})

/** 「未实现」项的说明后缀 */
const later = (phase: string, hint: string) => t('{hint}（{phase} 起生效）', { hint, phase })

export function PlayPresetEditor({
  value,
  onChange,
}: {
  value: PlayPresetData
  onChange: (value: PlayPresetData) => void
}) {
  const connections = useConnections()
  const set = <G extends Group, K extends keyof PlayPresetData[G]>(group: G, key: K, v: PlayPresetData[G][K]) =>
    onChange({ ...value, [group]: { ...value[group], [key]: v } })
  const { basic, directives, state, sprites, stage, dialog, interaction, trpg, audio } = value
  const off = !directives.enabled
  const schema = validateSchema(state.schema)

  return (
    <div className="space-y-2">
      <Section
        dense
        title={t('指令')}
        description={t('让模型在回复里写舞台指令：谁出场、什么表情、换场景、变量变化、选项')}
      >
        <SwitchField
          label={t('启用舞台指令')}
          hint={t('关闭后不解析、不注入、不隐藏，和普通聊天完全一样')}
          checked={directives.enabled}
          onChange={(v) => set('directives', 'enabled', v)}
        />
        <SelectField
          label={t('指令风格')}
          hint={t('教模型写哪一种。两种写法都能被识别，这里只决定指令说明里怎么教')}
          disabled={off}
          value={directives.style}
          onChange={(v) => set('directives', 'style', v)}
          options={[
            { value: 'shorthand', label: t('速记 + XML（省 token）') },
            { value: 'xml', label: t('全 XML（更规整）') },
          ]}
        />
        <SwitchField
          label={t('注入指令说明')}
          hint={t('往 Prompt 里加一段说明，告诉模型怎么写指令。关掉后需要你在角色卡或预设里自己写')}
          disabled={off}
          checked={directives.inject}
          onChange={(v) => set('directives', 'inject', v)}
        />
        <SwitchField
          label={t('末尾再提醒一次')}
          hint={t(
            '在整个 Prompt 最后（预设的结尾指令之后）加一段简短的格式要求。很多预设结尾会要求「只写正文、不给选项」，不提醒的话模型常常不写指令',
          )}
          disabled={off || !directives.inject}
          checked={directives.reminder}
          onChange={(v) => set('directives', 'reminder', v)}
        />
        <SelectField
          label={t('提醒的身份')}
          hint={t('有些接口（比如部分 Gemini 中转）会把中途的 system 消息挪走，提醒不起作用时改成「用户」试试')}
          disabled={off || !directives.inject || !directives.reminder}
          value={directives.reminderRole}
          onChange={(v) => set('directives', 'reminderRole', v)}
          options={[
            { value: 'system', label: t('系统') },
            { value: 'user', label: t('用户') },
          ]}
        />
        <SelectField
          label={t('什么时候给选项')}
          hint={t('需要勾选「选项」指令')}
          disabled={off || !directives.kinds.includes('choices')}
          value={directives.choicesMode}
          onChange={(v) => set('directives', 'choicesMode', v)}
          options={[
            { value: 'always', label: t('每条回复都给') },
            { value: 'auto', label: t('需要玩家做决定时') },
          ]}
        />
        <CheckGroupField
          label={t('启用的指令')}
          hint={t('只教模型写勾选的指令。没勾的指令写了也会被隐藏')}
          disabled={off}
          value={directives.kinds}
          onChange={(v) => set('directives', 'kinds', v)}
          options={KIND_OPTIONS()}
        />
        <SelectField
          label={t('注入位置')}
          disabled={off || !directives.inject}
          value={directives.position}
          onChange={(v) => set('directives', 'position', v)}
          options={[
            { value: 'after_char', label: t('角色设定之后') },
            { value: 'author_note', label: t('和作者注释同一深度') },
            { value: 'depth', label: t('指定深度') },
          ]}
        />
        {directives.position === 'depth' && (
          <NumberField
            label={t('注入深度')}
            hint={t('0 表示放在最后一条消息之后')}
            disabled={off || !directives.inject}
            min={0}
            max={1000}
            slider={false}
            value={directives.depth}
            onChange={(v) => set('directives', 'depth', Math.round(v))}
          />
        )}
        <CheckGroupField
          label={t('附带的清单')}
          hint={t('在指令说明里列出可用的名字，模型就不容易写错')}
          disabled={off || !directives.inject}
          value={directives.lists}
          onChange={(v) => set('directives', 'lists', v)}
          options={LIST_OPTIONS()}
        />
        <SwitchField
          label={t('历史中保留指令')}
          hint={t('发给模型的聊天记录里保留指令原文，模型会照着之前的写法写，更稳定')}
          disabled={off}
          checked={directives.keepInHistory}
          onChange={(v) => set('directives', 'keepInHistory', v)}
        />
        <NumberField
          label={t('只保留最近 N 条')}
          hint={t('更早消息里的指令换成纯文本，省 token。0 表示不限')}
          disabled={off || !directives.keepInHistory}
          min={0}
          max={1000}
          slider={false}
          value={directives.keepRecent}
          onChange={(v) => set('directives', 'keepRecent', Math.round(v))}
        />
        <SwitchField
          label={t('聊天中显示说话人')}
          hint={t('普通聊天视图里，台词显示成「名字：台词」；关闭后只显示台词')}
          disabled={off}
          checked={directives.showSpeaker}
          onChange={(v) => set('directives', 'showSpeaker', v)}
        />
        <TemplateField
          kind="template"
          disabled={off || !directives.inject}
          value={directives.template}
          style={directives.style}
          onChange={(v) => set('directives', 'template', v)}
        />
        <TemplateField
          kind="reminder"
          disabled={off || !directives.inject || !directives.reminder}
          value={directives.reminderTemplate}
          style={directives.style}
          onChange={(v) => set('directives', 'reminderTemplate', v)}
        />
      </Section>

      <Section dense title={t('变量')} description={t('好感度、HP、背包这类需要一直记住的数值，HUD 和指令说明都靠它')}>
        <SwitchField
          label={t('正文 <state> 更新变量')}
          hint={t('模型在回复末尾写 <state> 块来改变量，不需要工具调用')}
          disabled={off}
          checked={state.inline}
          onChange={(v) => set('state', 'inline', v)}
        />
        <SwitchField
          label={t('兼容 MVU 语法')}
          hint={t("识别酒馆 MVU 变量框架的 _.set('路径', 旧值, 新值)，方便直接用现成的状态栏卡")}
          disabled={off}
          checked={state.mvu}
          onChange={(v) => set('state', 'mvu', v)}
        />
        <SwitchField
          label={t('读取 [InitVar] 条目')}
          hint={t('开局时把世界书里备注带 [InitVar] 的条目（关闭的也算）作为变量初始值，MVU 卡的写法')}
          disabled={off}
          checked={state.initVar}
          onChange={(v) => set('state', 'initVar', v)}
        />
        <SwitchField
          label={t('说明里附当前值')}
          hint={t('指令说明里写上每个变量的当前值，模型更新时不容易算错')}
          disabled={off}
          checked={state.valuesInPrompt}
          onChange={(v) => set('state', 'valuesInPrompt', v)}
        />
        <SelectField
          label={t('状态定义来源')}
          hint={t('角色卡可以自带状态定义（扩展字段 ai_parter_vn.schema）')}
          disabled={off}
          value={state.schemaSource}
          onChange={(v) => set('state', 'schemaSource', v)}
          options={[
            { value: 'merge', label: t('合并（角色卡优先）') },
            { value: 'card', label: t('角色卡有就用角色卡的') },
            { value: 'preset', label: t('只用这里的') },
          ]}
        />
        <TextAreaField
          label={t('状态定义（JSON）')}
          hint={t(
            '键是变量路径，值是 { type, label, init, min, max, stages, rule, pin }。type 可选 meter / number / text / list / badge；init 是开局初始值；rule 会写进指令说明',
          )}
          disabled={off}
          mono
          rows={8}
          placeholder={`{\n  "${t('好感')}": { "type": "meter", "min": 0, "max": 100, "init": 30, "rule": "${t('温柔互动 +1~3')}" }\n}`}
          value={state.schema}
          onChange={(v) => set('state', 'schema', v)}
        />
        <p
          className={
            schema.error ? 'col-span-full -mt-0.5 text-xs text-red-600' : 'col-span-full -mt-0.5 text-xs text-zinc-400'
          }
        >
          {schema.error ?? (schema.count ? t('已定义 {count} 个变量', { count: schema.count }) : t('没有定义变量'))}
        </p>
      </Section>

      <Section dense title={t('跑团')} description={t('规则系统、骰子和旁白')}>
        <SelectField
          label={t('规则系统')}
          hint={later('VN5', t('检定、先攻和角色属性模板按这里的规则；目前只有 D&D 5e，其他规则先占位'))}
          notImplemented
          value={trpg.ruleSystem}
          onChange={(v) => set('trpg', 'ruleSystem', v)}
          options={(Object.keys(RULE_LABELS()) as RuleSystem[]).map((v) => ({
            value: v,
            label: IMPLEMENTED_RULE_SYSTEMS.includes(v)
              ? RULE_LABELS()[v]
              : t('{label}（未实现）', { label: RULE_LABELS()[v] }),
            disabled: !IMPLEMENTED_RULE_SYSTEMS.includes(v),
          }))}
        />
        <TextField
          label={t('旁白名称')}
          hint={t('「旁白：……」这样写的段落当作旁白，不算角色台词')}
          value={trpg.gmName}
          onChange={(v) => set('trpg', 'gmName', v)}
        />
        <SwitchField
          label={t('无说话人的文字当旁白')}
          hint={later('VN5', t('所有不带说话人的文字显示在旁白框里'))}
          notImplemented
          checked={trpg.narratorFallback}
          onChange={(v) => set('trpg', 'narratorFallback', v)}
        />
        <SwitchField
          label={t('骰子动画')}
          hint={later('VN5', t('掷骰结果显示成骰子卡片'))}
          notImplemented
          checked={trpg.diceAnimation}
          onChange={(v) => set('trpg', 'diceAnimation', v)}
        />
        <NumberField
          label={t('动画时长（毫秒）')}
          hint={later('VN5', t('骰子动画的时长'))}
          notImplemented
          min={0}
          max={5000}
          slider={false}
          value={trpg.diceMs}
          onChange={(v) => set('trpg', 'diceMs', Math.round(v))}
        />
        <SwitchField
          label={t('选项检定由前端掷骰')}
          hint={later('VN5', t('点带检定的选项时，由我们先掷骰再把结果发给模型，模型没法改结果'))}
          notImplemented
          checked={trpg.choiceRollClient}
          onChange={(v) => set('trpg', 'choiceRollClient', v)}
        />
        <SwitchField
          label={t('公开 DC')}
          hint={later('VN5', t('在选项上显示检定难度'))}
          notImplemented
          checked={trpg.showDc}
          onChange={(v) => set('trpg', 'showDc', v)}
        />
        <SwitchField
          label={t('大成功 / 大失败')}
          hint={later('VN5', t('d20 掷出 20 / 1 时自动成功 / 失败'))}
          notImplemented
          checked={trpg.critRules}
          onChange={(v) => set('trpg', 'critRules', v)}
        />
        <SwitchField
          label={t('战斗时显示先攻条')}
          hint={later('VN5', t('战斗开始后在顶部显示行动顺序'))}
          notImplemented
          checked={trpg.initiativeBar}
          onChange={(v) => set('trpg', 'initiativeBar', v)}
        />
      </Section>

      <Section
        dense
        title={t('表情与立绘')}
        description={t('立绘在角色编辑页上传；模型没写表情时可以再调一次模型判断')}
      >
        <SelectField
          label={t('兜底表情')}
          hint={t('模型写了没有立绘的表情时显示哪一个')}
          value={sprites.fallback}
          onChange={(v) => set('sprites', 'fallback', v)}
          options={[{ value: '', label: t('不显示') }, ...EXPRESSIONS.map((e) => ({ value: e, label: e }))]}
        />
        <SelectField
          label={t('兜底情绪判断')}
          hint={t('模型没写表情时，再调一次模型判断这条回复的情绪')}
          value={sprites.classify}
          onChange={(v) => set('sprites', 'classify', v)}
          options={[
            { value: 'missing', label: t('只在没写表情时') },
            { value: 'always', label: t('总是') },
            { value: 'off', label: t('禁用') },
          ]}
        />
        <SelectField
          label={t('判断用的连接')}
          hint={t('可以选一个便宜的模型来判断情绪')}
          value={sprites.classifyConnectionId ?? ''}
          onChange={(v) => set('sprites', 'classifyConnectionId', v || null)}
          options={[
            { value: '', label: t('跟随会话') },
            ...(connections.data ?? []).map((c) => ({ value: c.id, label: `${c.name}（${c.model}）` })),
          ]}
        />
        <TextField
          label={t('判断用的模型')}
          hint={t('留空则用连接里的模型')}
          value={sprites.classifyModel}
          onChange={(v) => set('sprites', 'classifyModel', v)}
        />
        <SelectField
          label={t('判断上下文')}
          hint={t('只看最后一条更快更省；完整上下文更准')}
          value={sprites.classifyContext}
          onChange={(v) => set('sprites', 'classifyContext', v)}
          options={[
            { value: 'last', label: t('只看最后一条') },
            { value: 'full', label: t('完整上下文') },
          ]}
        />
        <SelectField
          label={t('聊天中的侧边立绘')}
          hint={t('不进 VN 视图时，在聊天区旁边显示当前说话人的立绘')}
          value={sprites.sideSprite}
          onChange={(v) => set('sprites', 'sideSprite', v)}
          options={[
            { value: 'right', label: t('右侧') },
            { value: 'top', label: t('顶部') },
            { value: 'off', label: t('禁用') },
          ]}
        />
        <SwitchField
          label={t('没有立绘时用头像')}
          hint={t('没有立绘的角色用角色卡头像代替')}
          checked={sprites.avatarFallback}
          onChange={(v) => set('sprites', 'avatarFallback', v)}
        />
        <SwitchField
          label={t('同一表情多张时随机')}
          hint={t('同一个表情有多张立绘时随机挑一张')}
          checked={sprites.randomMultiple}
          onChange={(v) => set('sprites', 'randomMultiple', v)}
        />
        <SwitchField
          label={t('重复表情时换一张')}
          hint={t('同一个表情有多张立绘时，换拍后避开上一次显示的那张')}
          checked={sprites.rerollSame}
          onChange={(v) => set('sprites', 'rerollSame', v)}
        />
        <DenseRow
          label={t('自定义表情')}
          hint={t('在酒馆的 28 种之外再加表情名（英文），会出现在指令说明的表情清单里')}
          wide
        >
          <div className="min-w-0 flex-1 py-1">
            <TagInput
              label={t('自定义表情')}
              value={sprites.customExpressions}
              onChange={(v) => set('sprites', 'customExpressions', v)}
            />
          </div>
        </DenseRow>
        <TextAreaField
          label={t('判断提示词')}
          hint={t('留空则用酒馆的默认提示词，{{labels}} 会替换成表情列表')}
          mono
          rows={3}
          placeholder="Classify the emotion of the last message. Output just one word… {{labels}}"
          value={sprites.classifyPrompt}
          onChange={(v) => set('sprites', 'classifyPrompt', v)}
        />
      </Section>

      <Section dense title={t('VN 视图')} description={t('版式、舞台和对话框')}>
        <SwitchField
          label={t('默认以 VN 视图打开')}
          hint={t('用这个预设的新会话一打开就是 VN 视图')}
          checked={basic.openInVn}
          onChange={(v) => set('basic', 'openInVn', v)}
        />
        <SelectField
          label={t('版式')}
          hint={t('ADV：底部对话框；NVL：全屏文本；自动：旁白长时切 NVL')}
          value={basic.layout}
          onChange={(v) => set('basic', 'layout', v)}
          options={[
            { value: 'adv', label: t('ADV（底部对话框）') },
            { value: 'nvl', label: t('NVL（全屏文本）') },
            { value: 'auto', label: t('自动') },
          ]}
        />
        {basic.layout === 'auto' && (
          <NumberField
            label={t('切 NVL 的字数')}
            hint={t('旁白超过这么多字时自动切成全屏文本')}
            min={20}
            max={5000}
            slider={false}
            value={basic.nvlThreshold}
            onChange={(v) => set('basic', 'nvlThreshold', Math.round(v))}
          />
        )}
        <NumberField
          label={t('文字速度（字/秒）')}
          hint={t('打字机效果的速度，0 表示瞬间显示')}
          min={0}
          max={200}
          value={dialog.cps}
          onChange={(v) => set('dialog', 'cps', Math.round(v))}
        />
        <NumberField
          label={t('自动播放停顿（秒）')}
          hint={t('自动播放时每句之间停多久')}
          min={0}
          max={10}
          step={0.1}
          value={dialog.autoDelay}
          onChange={(v) => set('dialog', 'autoDelay', v)}
        />
        <NumberField
          label={t('旁白拆分长度')}
          hint={t('一段旁白超过这么多字时拆成几拍显示')}
          min={20}
          max={2000}
          slider={false}
          value={dialog.narrationSplit}
          onChange={(v) => set('dialog', 'narrationSplit', Math.round(v))}
        />
        <NumberField
          label={t('对话框不透明度')}
          hint={t('百分比')}
          min={0}
          max={100}
          value={dialog.boxOpacity}
          onChange={(v) => set('dialog', 'boxOpacity', Math.round(v))}
        />
        <NumberField
          label={t('对话框字号')}
          hint={t('像素')}
          min={12}
          max={32}
          value={dialog.fontSize}
          onChange={(v) => set('dialog', 'fontSize', Math.round(v))}
        />
        <NumberField
          label={t('最多同屏人数')}
          hint={t('手机上最多 2 人')}
          min={1}
          max={5}
          value={stage.maxCast}
          onChange={(v) => set('stage', 'maxCast', Math.round(v))}
        />
        <NumberField
          label={t('立绘大小（%）')}
          hint={t('立绘的缩放比例')}
          min={50}
          max={200}
          value={stage.spriteScale}
          onChange={(v) => set('stage', 'spriteScale', Math.round(v))}
        />
        <NumberField
          label={t('非说话人变暗（%）')}
          hint={t('焦点模式下，不说话的人变暗的程度')}
          min={0}
          max={90}
          value={stage.dim}
          onChange={(v) => set('stage', 'dim', Math.round(v))}
        />
        <SwitchField
          label={t('焦点模式')}
          hint={t('正在说话的人在最上层、正常亮度，其他人变暗')}
          checked={stage.focus}
          onChange={(v) => set('stage', 'focus', v)}
        />
        <SwitchField
          label={t('自动生成缺少的背景')}
          hint={t(
            '模型换到背景库里没有的场景时，用图片生成扩展画一张，并用模型写的场景名命名（需要启用并配置图片生成）',
          )}
          checked={stage.autoBackground}
          onChange={(v) => set('stage', 'autoBackground', v)}
        />
        <SwitchField
          label={t('允许调整立绘')}
          hint={t('VN 视图和聊天视图的侧边立绘可以拖动位置、缩放大小（只保存在这台设备上）')}
          checked={stage.draggable}
          onChange={(v) => set('stage', 'draggable', v)}
        />
        <SwitchField
          label={t('显示名牌')}
          hint={t('对话框上方显示说话人名字')}
          checked={dialog.nameplate}
          onChange={(v) => set('dialog', 'nameplate', v)}
        />
        <SwitchField
          label={t('边生成边播放')}
          hint={t('流式生成时，第一句写完就开始演')}
          checked={dialog.streamPlay}
          onChange={(v) => set('dialog', 'streamPlay', v)}
        />
        <SwitchField
          label={t('默认自动播放')}
          hint={t('打开 VN 视图时自动推进')}
          checked={dialog.autoDefault}
          onChange={(v) => set('dialog', 'autoDefault', v)}
        />
        <SwitchField
          label={t('快进只跳读过的')}
          hint={t('快进遇到新生成的内容会停下')}
          checked={dialog.skipReadOnly}
          onChange={(v) => set('dialog', 'skipReadOnly', v)}
        />
        <SelectField
          label={t('未知角色')}
          hint={t('模型写了没有立绘也没有角色卡的人（临时 NPC）时怎么显示')}
          value={stage.unknownActor}
          onChange={(v) => set('stage', 'unknownActor', v)}
          options={[
            { value: 'silhouette', label: t('剪影 + 名牌') },
            { value: 'generate', label: t('自动生成立绘') },
            { value: 'hide', label: t('不显示') },
          ]}
        />
        <SelectField
          label={t('转场效果')}
          hint={t('换背景、立绘上台和 CG 出现时的过渡。淡入：旧画面先暗下去；溶解：新画面直接叠上来')}
          value={stage.transition}
          onChange={(v) => set('stage', 'transition', v)}
          options={[
            { value: 'fade', label: t('淡入') },
            { value: 'dissolve', label: t('溶解') },
            { value: 'none', label: t('无') },
          ]}
        />
        <NumberField
          label={t('转场时长（毫秒）')}
          hint={t('过渡动画的时长')}
          min={0}
          max={5000}
          slider={false}
          value={stage.transitionMs}
          onChange={(v) => set('stage', 'transitionMs', Math.round(v))}
        />
        <SwitchField
          label={t('电影模式')}
          hint={t('默认以电影模式打开：上下黑边，隐藏状态面板，对话变成字幕。VN 视图右上角也可以临时切换')}
          checked={stage.letterbox}
          onChange={(v) => set('stage', 'letterbox', v)}
        />
        <SwitchField
          label={t('自动生成 CG')}
          hint={t('模型写了 <cg> 指令时，用图片生成扩展画出来，播放到这里全屏显示（需要勾选「CG」指令并配置图片生成）')}
          checked={stage.cgAuto}
          onChange={(v) => set('stage', 'cgAuto', v)}
        />
      </Section>

      <Section dense title={t('互动')} description={t('选项、状态面板和存档')}>
        <SwitchField
          label={t('显示选项')}
          hint={t('模型给出的 <choices> 显示成按钮，点一下就发出去')}
          checked={interaction.choices}
          onChange={(v) => set('interaction', 'choices', v)}
        />
        <SwitchField
          label={t('有选项时仍显示输入框')}
          hint={t('VN 视图里有选项时，是否还能自由输入')}
          checked={interaction.inputWithChoices}
          onChange={(v) => set('interaction', 'inputWithChoices', v)}
        />
        <SelectField
          label={t('选项排列')}
          hint={t('VN 视图里选项按钮的排法')}
          value={interaction.choiceLayout}
          onChange={(v) => set('interaction', 'choiceLayout', v)}
          options={[
            { value: 'auto', label: t('自动') },
            { value: 'row', label: t('横排') },
            { value: 'column', label: t('竖排') },
          ]}
        />
        <SwitchField
          label={t('显示 HUD')}
          hint={t('在画面上显示状态面板（好感、HP……）')}
          checked={interaction.hud}
          onChange={(v) => set('interaction', 'hud', v)}
        />
        <SwitchField
          label={t('允许修改数值')}
          hint={t('玩家可以在状态面板里直接改数值（好感、HP……）；关掉后只能由剧情改变')}
          checked={interaction.varEdit}
          onChange={(v) => set('interaction', 'varEdit', v)}
        />
        <SelectField
          label={t('HUD 位置')}
          hint={t('手机上总是顶部一行')}
          value={interaction.hudPosition}
          onChange={(v) => set('interaction', 'hudPosition', v)}
          options={[
            { value: 'top-right', label: t('右上') },
            { value: 'top-left', label: t('左上') },
            { value: 'top-bar', label: t('顶部一行') },
          ]}
        />
        <SwitchField
          label={t('数值变化飘字')}
          hint={t('变量变化时显示 +2 / −5')}
          checked={interaction.floatDelta}
          onChange={(v) => set('interaction', 'floatDelta', v)}
        />
        <SwitchField
          label={t('阶段变化触发世界书')}
          hint={t(
            '变量进入某个阶段后，关键词写成「变量名_stage: 阶段名」（比如 affection_stage: Lovers）的世界书条目会触发；也可以在提示词里用 {{stage::变量名}}',
          )}
          checked={interaction.stageLore}
          onChange={(v) => set('interaction', 'stageLore', v)}
        />
        <SwitchField
          label={t('存档缩略图')}
          hint={t('存档时保存一张画面缩略图')}
          checked={interaction.saveThumb}
          onChange={(v) => set('interaction', 'saveThumb', v)}
        />
      </Section>

      <Section dense title={t('音频')} description={t('BGM、音效和语音，以后做，现在先留好设置')} defaultOpen={false}>
        <SwitchField
          label={t('启用 BGM')}
          hint={later(t('以后'), t('按场景指令播放背景音乐'))}
          notImplemented
          checked={audio.bgm}
          onChange={(v) => set('audio', 'bgm', v)}
        />
        <NumberField
          label={t('BGM 音量')}
          notImplemented
          min={0}
          max={100}
          value={audio.bgmVolume}
          onChange={(v) => set('audio', 'bgmVolume', Math.round(v))}
        />
        <NumberField
          label={t('音效音量')}
          notImplemented
          min={0}
          max={100}
          value={audio.sfxVolume}
          onChange={(v) => set('audio', 'sfxVolume', Math.round(v))}
        />
        <NumberField
          label={t('语音音量')}
          notImplemented
          min={0}
          max={100}
          value={audio.voiceVolume}
          onChange={(v) => set('audio', 'voiceVolume', Math.round(v))}
        />
        <NumberField
          label={t('淡入淡出（毫秒）')}
          notImplemented
          min={0}
          max={10000}
          slider={false}
          value={audio.fadeMs}
          onChange={(v) => set('audio', 'fadeMs', Math.round(v))}
        />
      </Section>
    </div>
  )
}

/** 指令说明模板 / 末尾提醒模板：留空用默认模板；可以一键填入默认模板再改 */
function TemplateField({
  kind,
  value,
  style,
  disabled,
  onChange,
}: {
  kind: 'template' | 'reminder'
  value: string
  style: 'shorthand' | 'xml'
  disabled: boolean
  onChange: (v: string) => void
}) {
  const defaults = kind === 'template' ? DEFAULT_DIRECTIVE_TEMPLATES[style] : DEFAULT_DIRECTIVE_REMINDERS[style]
  return (
    <div className="col-span-full space-y-1">
      <TextAreaField
        label={kind === 'template' ? t('指令说明模板') : t('末尾提醒模板')}
        hint={
          kind === 'template'
            ? t(
                '留空用默认模板。可用占位符：{{vn_kinds}} 指令写法、{{vn_cast}} 角色、{{vn_expressions}} 表情、{{vn_backgrounds}} 背景、{{vn_outfits}} 服装、{{vn_state}} 变量、{{vn_example}} 示例回复；为空的占位符所在的行会被整行去掉',
              )
            : t('留空用默认模板。占位符 {{vn_rules}} 会换成按启用的指令生成的必须项，每条一行')
        }
        disabled={disabled}
        mono
        rows={value ? 8 : 3}
        placeholder={t('（使用默认模板）{newline}{preview}…', {
          newline: '\n',
          preview: defaults.split('\n').slice(0, 2).join('\n'),
        })}
        value={value}
        onChange={onChange}
      />
      <div className="flex justify-end gap-1.5">
        {value && (
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange('')}>
            {t('恢复默认')}
          </Button>
        )}
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => {
            if (!value || confirm(t('用默认模板覆盖当前内容？'))) onChange(defaults)
          }}
        >
          {t('填入默认模板')}
        </Button>
      </div>
    </div>
  )
}

/** 检查状态定义的 JSON：返回变量个数或中文错误 */
function validateSchema(text: string): { count: number; error?: string } {
  if (!text.trim()) return { count: 0 }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { count: 0, error: t('不是合法的 JSON：{error}', { error: e instanceof Error ? e.message : String(e) }) }
  }
  const parsed = stateSchemaSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      count: 0,
      error: t('格式不对：{path} {message}', { path: issue?.path.join('.') || t('根'), message: issue?.message ?? '' }),
    }
  }
  return { count: Object.keys(parsed.data).length }
}
