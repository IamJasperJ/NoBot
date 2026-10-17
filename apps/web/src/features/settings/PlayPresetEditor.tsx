import {
  DEFAULT_DIRECTIVE_TEMPLATES,
  DIRECTIVE_KIND_LABELS,
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

/**
 * 玩法预设编辑器：设计稿（docs/design/vn-mode.md）第 11 节的全部设置项，按分组排成紧凑多列。
 * 还没实现的设置项照样可以改和保存，标「未实现」，说明里写明从哪一期开始生效。
 */

type Group = keyof PlayPresetData

const KIND_OPTIONS = (Object.keys(DIRECTIVE_KIND_LABELS) as DirectiveKind[]).map((value) => ({
  value,
  label: DIRECTIVE_KIND_LABELS[value],
  // 第一期只处理表情、上下台、场景、变量、选项；其余种类先只隐藏不演出
  notImplemented: !['expression', 'cast', 'scene', 'state', 'choices'].includes(value),
}))

const LIST_OPTIONS: { value: PromptList; label: string }[] = [
  { value: 'cast', label: '角色' },
  { value: 'expressions', label: '表情' },
  { value: 'backgrounds', label: '背景' },
  { value: 'vars', label: '变量' },
]

const RULE_LABELS: Record<RuleSystem, string> = {
  dnd5e: 'D&D 5e',
  coc7: '克苏鲁的呼唤 7 版',
  pf2e: 'Pathfinder 2e',
  pbta: '简易 2d6（PbtA）',
  custom: '自定义',
}

/** 「未实现」项的说明后缀 */
const later = (phase: string, hint: string) => `${hint}（${phase} 起生效）`

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
      <Section dense title="指令" description="让模型在回复里写舞台指令：谁出场、什么表情、换场景、变量变化、选项">
        <SwitchField
          label="启用舞台指令"
          hint="关闭后不解析、不注入、不隐藏，和普通聊天完全一样"
          checked={directives.enabled}
          onChange={(v) => set('directives', 'enabled', v)}
        />
        <SelectField
          label="指令风格"
          hint="教模型写哪一种。两种写法都能被识别，这里只决定指令说明里怎么教"
          disabled={off}
          value={directives.style}
          onChange={(v) => set('directives', 'style', v)}
          options={[
            { value: 'shorthand', label: '速记 + XML（省 token）' },
            { value: 'xml', label: '全 XML（更规整）' },
          ]}
        />
        <SwitchField
          label="注入指令说明"
          hint="往 Prompt 里加一段说明，告诉模型怎么写指令。关掉后需要你在角色卡或预设里自己写"
          disabled={off}
          checked={directives.inject}
          onChange={(v) => set('directives', 'inject', v)}
        />
        <CheckGroupField
          label="启用的指令"
          hint="只教模型写勾选的指令。没勾的指令写了也会被隐藏"
          disabled={off}
          value={directives.kinds}
          onChange={(v) => set('directives', 'kinds', v)}
          options={KIND_OPTIONS}
        />
        <SelectField
          label="注入位置"
          disabled={off || !directives.inject}
          value={directives.position}
          onChange={(v) => set('directives', 'position', v)}
          options={[
            { value: 'after_char', label: '角色设定之后' },
            { value: 'author_note', label: '和作者注释同一深度' },
            { value: 'depth', label: '指定深度' },
          ]}
        />
        {directives.position === 'depth' && (
          <NumberField
            label="注入深度"
            hint="0 表示放在最后一条消息之后"
            disabled={off || !directives.inject}
            min={0}
            max={1000}
            slider={false}
            value={directives.depth}
            onChange={(v) => set('directives', 'depth', Math.round(v))}
          />
        )}
        <CheckGroupField
          label="附带的清单"
          hint="在指令说明里列出可用的名字，模型就不容易写错"
          disabled={off || !directives.inject}
          value={directives.lists}
          onChange={(v) => set('directives', 'lists', v)}
          options={LIST_OPTIONS}
        />
        <SwitchField
          label="历史中保留指令"
          hint="发给模型的聊天记录里保留指令原文，模型会照着之前的写法写，更稳定"
          disabled={off}
          checked={directives.keepInHistory}
          onChange={(v) => set('directives', 'keepInHistory', v)}
        />
        <NumberField
          label="只保留最近 N 条"
          hint="更早消息里的指令换成纯文本，省 token。0 表示不限"
          disabled={off || !directives.keepInHistory}
          min={0}
          max={1000}
          slider={false}
          value={directives.keepRecent}
          onChange={(v) => set('directives', 'keepRecent', Math.round(v))}
        />
        <SwitchField
          label="聊天中显示说话人"
          hint="普通聊天视图里，台词显示成「名字：台词」；关闭后只显示台词"
          disabled={off}
          checked={directives.showSpeaker}
          onChange={(v) => set('directives', 'showSpeaker', v)}
        />
        <TemplateField
          disabled={off || !directives.inject}
          value={directives.template}
          style={directives.style}
          onChange={(v) => set('directives', 'template', v)}
        />
      </Section>

      <Section dense title="变量" description="好感度、HP、背包这类需要一直记住的数值，HUD 和指令说明都靠它">
        <SwitchField
          label="正文 <state> 更新变量"
          hint="模型在回复末尾写 <state> 块来改变量，不需要工具调用"
          disabled={off}
          checked={state.inline}
          onChange={(v) => set('state', 'inline', v)}
        />
        <SwitchField
          label="兼容 MVU 语法"
          hint="识别酒馆 MVU 变量框架的 _.set('路径', 旧值, 新值)，方便直接用现成的状态栏卡"
          disabled={off}
          checked={state.mvu}
          onChange={(v) => set('state', 'mvu', v)}
        />
        <SwitchField
          label="读取 [InitVar] 条目"
          hint="开局时把世界书里备注带 [InitVar] 的条目（关闭的也算）作为变量初始值，MVU 卡的写法"
          disabled={off}
          checked={state.initVar}
          onChange={(v) => set('state', 'initVar', v)}
        />
        <SwitchField
          label="说明里附当前值"
          hint="指令说明里写上每个变量的当前值，模型更新时不容易算错"
          disabled={off}
          checked={state.valuesInPrompt}
          onChange={(v) => set('state', 'valuesInPrompt', v)}
        />
        <SelectField
          label="状态定义来源"
          hint="角色卡可以自带状态定义（扩展字段 ai_parter_vn.schema）"
          disabled={off}
          value={state.schemaSource}
          onChange={(v) => set('state', 'schemaSource', v)}
          options={[
            { value: 'merge', label: '合并（角色卡优先）' },
            { value: 'card', label: '角色卡有就用角色卡的' },
            { value: 'preset', label: '只用这里的' },
          ]}
        />
        <TextAreaField
          label="状态定义（JSON）"
          hint={
            '键是变量路径，值是 { type, label, init, min, max, stages, rule, pin }。type 可选 meter / number / text / list / badge；init 是开局初始值；rule 会写进指令说明'
          }
          disabled={off}
          mono
          rows={8}
          placeholder={'{\n  "好感": { "type": "meter", "min": 0, "max": 100, "init": 30, "rule": "温柔互动 +1~3" }\n}'}
          value={state.schema}
          onChange={(v) => set('state', 'schema', v)}
        />
        <p
          className={
            schema.error ? 'col-span-full -mt-0.5 text-xs text-red-600' : 'col-span-full -mt-0.5 text-xs text-zinc-400'
          }
        >
          {schema.error ?? (schema.count ? `已定义 ${schema.count} 个变量` : '没有定义变量')}
        </p>
      </Section>

      <Section dense title="跑团" description="规则系统、骰子和旁白">
        <SelectField
          label="规则系统"
          hint={later('VN5', '检定、先攻和角色属性模板按这里的规则；目前只有 D&D 5e，其他规则先占位')}
          notImplemented
          value={trpg.ruleSystem}
          onChange={(v) => set('trpg', 'ruleSystem', v)}
          options={(Object.keys(RULE_LABELS) as RuleSystem[]).map((v) => ({
            value: v,
            label: IMPLEMENTED_RULE_SYSTEMS.includes(v) ? RULE_LABELS[v] : `${RULE_LABELS[v]}（未实现）`,
            disabled: !IMPLEMENTED_RULE_SYSTEMS.includes(v),
          }))}
        />
        <TextField
          label="旁白名称"
          hint="「旁白：……」这样写的段落当作旁白，不算角色台词"
          value={trpg.gmName}
          onChange={(v) => set('trpg', 'gmName', v)}
        />
        <SwitchField
          label="无说话人的文字当旁白"
          hint={later('VN5', '所有不带说话人的文字显示在旁白框里')}
          notImplemented
          checked={trpg.narratorFallback}
          onChange={(v) => set('trpg', 'narratorFallback', v)}
        />
        <SwitchField
          label="骰子动画"
          hint={later('VN5', '掷骰结果显示成骰子卡片')}
          notImplemented
          checked={trpg.diceAnimation}
          onChange={(v) => set('trpg', 'diceAnimation', v)}
        />
        <NumberField
          label="动画时长（毫秒）"
          hint={later('VN5', '骰子动画的时长')}
          notImplemented
          min={0}
          max={5000}
          slider={false}
          value={trpg.diceMs}
          onChange={(v) => set('trpg', 'diceMs', Math.round(v))}
        />
        <SwitchField
          label="选项检定由前端掷骰"
          hint={later('VN5', '点带检定的选项时，由我们先掷骰再把结果发给模型，模型没法改结果')}
          notImplemented
          checked={trpg.choiceRollClient}
          onChange={(v) => set('trpg', 'choiceRollClient', v)}
        />
        <SwitchField
          label="公开 DC"
          hint={later('VN5', '在选项上显示检定难度')}
          notImplemented
          checked={trpg.showDc}
          onChange={(v) => set('trpg', 'showDc', v)}
        />
        <SwitchField
          label="大成功 / 大失败"
          hint={later('VN5', 'd20 掷出 20 / 1 时自动成功 / 失败')}
          notImplemented
          checked={trpg.critRules}
          onChange={(v) => set('trpg', 'critRules', v)}
        />
        <SwitchField
          label="战斗时显示先攻条"
          hint={later('VN5', '战斗开始后在顶部显示行动顺序')}
          notImplemented
          checked={trpg.initiativeBar}
          onChange={(v) => set('trpg', 'initiativeBar', v)}
        />
      </Section>

      <Section dense title="表情与立绘" description="立绘在角色编辑页上传；模型没写表情时可以再调一次模型判断">
        <SelectField
          label="兜底表情"
          hint="模型写了没有立绘的表情时显示哪一个"
          value={sprites.fallback}
          onChange={(v) => set('sprites', 'fallback', v)}
          options={[{ value: '', label: '不显示' }, ...EXPRESSIONS.map((e) => ({ value: e, label: e }))]}
        />
        <SelectField
          label="兜底情绪判断"
          hint="模型没写表情时，再调一次模型判断这条回复的情绪"
          value={sprites.classify}
          onChange={(v) => set('sprites', 'classify', v)}
          options={[
            { value: 'missing', label: '只在没写表情时' },
            { value: 'always', label: '总是' },
            { value: 'off', label: '关闭' },
          ]}
        />
        <SelectField
          label="判断用的连接"
          hint="可以选一个便宜的模型来判断情绪"
          value={sprites.classifyConnectionId ?? ''}
          onChange={(v) => set('sprites', 'classifyConnectionId', v || null)}
          options={[
            { value: '', label: '跟随会话' },
            ...(connections.data ?? []).map((c) => ({ value: c.id, label: `${c.name}（${c.model}）` })),
          ]}
        />
        <TextField
          label="判断用的模型"
          hint="留空则用连接里的模型"
          value={sprites.classifyModel}
          onChange={(v) => set('sprites', 'classifyModel', v)}
        />
        <SelectField
          label="判断上下文"
          hint="只看最后一条更快更省；完整上下文更准"
          value={sprites.classifyContext}
          onChange={(v) => set('sprites', 'classifyContext', v)}
          options={[
            { value: 'last', label: '只看最后一条' },
            { value: 'full', label: '完整上下文' },
          ]}
        />
        <SelectField
          label="聊天中的侧边立绘"
          hint="不进 VN 视图时，在聊天区旁边显示当前说话人的立绘"
          value={sprites.sideSprite}
          onChange={(v) => set('sprites', 'sideSprite', v)}
          options={[
            { value: 'right', label: '右侧' },
            { value: 'top', label: '顶部' },
            { value: 'off', label: '关闭' },
          ]}
        />
        <SwitchField
          label="没有立绘时用头像"
          hint="没有立绘的角色用角色卡头像代替"
          checked={sprites.avatarFallback}
          onChange={(v) => set('sprites', 'avatarFallback', v)}
        />
        <SwitchField
          label="同一表情多张时随机"
          hint="同一个表情有多张立绘时随机挑一张"
          checked={sprites.randomMultiple}
          onChange={(v) => set('sprites', 'randomMultiple', v)}
        />
        <SwitchField
          label="重复表情时换一张"
          hint={later('VN3', '连续两次同一个表情时，强制换一张不同的立绘')}
          notImplemented
          checked={sprites.rerollSame}
          onChange={(v) => set('sprites', 'rerollSame', v)}
        />
        <DenseRow label="自定义表情" hint="在酒馆的 28 种之外再加表情名（英文），会出现在指令说明的表情清单里" wide>
          <div className="min-w-0 flex-1 py-1">
            <TagInput
              label="自定义表情"
              value={sprites.customExpressions}
              onChange={(v) => set('sprites', 'customExpressions', v)}
            />
          </div>
        </DenseRow>
        <TextAreaField
          label="判断提示词"
          hint="留空则用酒馆的默认提示词，{{labels}} 会替换成表情列表"
          mono
          rows={3}
          placeholder="Classify the emotion of the last message. Output just one word… {{labels}}"
          value={sprites.classifyPrompt}
          onChange={(v) => set('sprites', 'classifyPrompt', v)}
        />
      </Section>

      <Section dense title="VN 视图" description="版式、舞台和对话框（VN3）">
        <SwitchField
          label="默认以 VN 视图打开"
          hint={later('VN3', '用这个预设的新会话一打开就是 VN 视图')}
          notImplemented
          checked={basic.openInVn}
          onChange={(v) => set('basic', 'openInVn', v)}
        />
        <SelectField
          label="版式"
          hint={later('VN3', 'ADV：底部对话框；NVL：全屏文本；自动：旁白长时切 NVL')}
          notImplemented
          value={basic.layout}
          onChange={(v) => set('basic', 'layout', v)}
          options={[
            { value: 'adv', label: 'ADV（底部对话框）' },
            { value: 'nvl', label: 'NVL（全屏文本）' },
            { value: 'auto', label: '自动' },
          ]}
        />
        {basic.layout === 'auto' && (
          <NumberField
            label="切 NVL 的字数"
            hint={later('VN3', '旁白超过这么多字时自动切成全屏文本')}
            notImplemented
            min={20}
            max={5000}
            slider={false}
            value={basic.nvlThreshold}
            onChange={(v) => set('basic', 'nvlThreshold', Math.round(v))}
          />
        )}
        <NumberField
          label="文字速度（字/秒）"
          hint={later('VN3', '打字机效果的速度，0 表示瞬间显示')}
          notImplemented
          min={0}
          max={200}
          value={dialog.cps}
          onChange={(v) => set('dialog', 'cps', Math.round(v))}
        />
        <NumberField
          label="自动播放停顿（秒）"
          hint={later('VN3', '自动播放时每句之间停多久')}
          notImplemented
          min={0}
          max={10}
          step={0.1}
          value={dialog.autoDelay}
          onChange={(v) => set('dialog', 'autoDelay', v)}
        />
        <NumberField
          label="旁白拆分长度"
          hint={later('VN3', '一段旁白超过这么多字时拆成几拍显示')}
          notImplemented
          min={20}
          max={2000}
          slider={false}
          value={dialog.narrationSplit}
          onChange={(v) => set('dialog', 'narrationSplit', Math.round(v))}
        />
        <NumberField
          label="对话框不透明度"
          hint={later('VN3', '百分比')}
          notImplemented
          min={0}
          max={100}
          value={dialog.boxOpacity}
          onChange={(v) => set('dialog', 'boxOpacity', Math.round(v))}
        />
        <NumberField
          label="对话框字号"
          hint={later('VN3', '像素')}
          notImplemented
          min={12}
          max={32}
          value={dialog.fontSize}
          onChange={(v) => set('dialog', 'fontSize', Math.round(v))}
        />
        <NumberField
          label="最多同屏人数"
          hint={later('VN3', '手机上最多 2 人')}
          notImplemented
          min={1}
          max={5}
          value={stage.maxCast}
          onChange={(v) => set('stage', 'maxCast', Math.round(v))}
        />
        <NumberField
          label="立绘大小（%）"
          hint={later('VN3', '立绘的缩放比例')}
          notImplemented
          min={50}
          max={200}
          value={stage.spriteScale}
          onChange={(v) => set('stage', 'spriteScale', Math.round(v))}
        />
        <NumberField
          label="非说话人变暗（%）"
          hint={later('VN3', '焦点模式下，不说话的人变暗的程度')}
          notImplemented
          min={0}
          max={90}
          value={stage.dim}
          onChange={(v) => set('stage', 'dim', Math.round(v))}
        />
        <SwitchField
          label="焦点模式"
          hint={later('VN3', '正在说话的人在最上层、正常亮度，其他人变暗')}
          notImplemented
          checked={stage.focus}
          onChange={(v) => set('stage', 'focus', v)}
        />
        <SwitchField
          label="允许拖动站位"
          hint={later('VN3', '桌面端可以拖动立绘微调位置')}
          notImplemented
          checked={stage.draggable}
          onChange={(v) => set('stage', 'draggable', v)}
        />
        <SwitchField
          label="显示名牌"
          hint={later('VN3', '对话框上方显示说话人名字')}
          notImplemented
          checked={dialog.nameplate}
          onChange={(v) => set('dialog', 'nameplate', v)}
        />
        <SwitchField
          label="边生成边播放"
          hint={later('VN3', '流式生成时，第一句写完就开始演')}
          notImplemented
          checked={dialog.streamPlay}
          onChange={(v) => set('dialog', 'streamPlay', v)}
        />
        <SwitchField
          label="默认自动播放"
          hint={later('VN3', '打开 VN 视图时自动推进')}
          notImplemented
          checked={dialog.autoDefault}
          onChange={(v) => set('dialog', 'autoDefault', v)}
        />
        <SwitchField
          label="快进只跳读过的"
          hint={later('VN3', '快进遇到新生成的内容会停下')}
          notImplemented
          checked={dialog.skipReadOnly}
          onChange={(v) => set('dialog', 'skipReadOnly', v)}
        />
        <SelectField
          label="未知角色"
          hint={later('VN5', '模型写了没有立绘也没有角色卡的人（临时 NPC）时怎么显示')}
          notImplemented
          value={stage.unknownActor}
          onChange={(v) => set('stage', 'unknownActor', v)}
          options={[
            { value: 'silhouette', label: '剪影 + 名牌' },
            { value: 'generate', label: '自动生成头像' },
            { value: 'hide', label: '不显示' },
          ]}
        />
        <SelectField
          label="转场效果"
          hint={later('VN6', '换场景、上下台时的过渡')}
          notImplemented
          value={stage.transition}
          onChange={(v) => set('stage', 'transition', v)}
          options={[
            { value: 'fade', label: '淡入' },
            { value: 'dissolve', label: '溶解' },
            { value: 'none', label: '无' },
          ]}
        />
        <NumberField
          label="转场时长（毫秒）"
          hint={later('VN6', '过渡动画的时长')}
          notImplemented
          min={0}
          max={5000}
          slider={false}
          value={stage.transitionMs}
          onChange={(v) => set('stage', 'transitionMs', Math.round(v))}
        />
        <SwitchField
          label="电影模式"
          hint={later('VN6', '上下黑边，隐藏界面，只剩字幕')}
          notImplemented
          checked={stage.letterbox}
          onChange={(v) => set('stage', 'letterbox', v)}
        />
      </Section>

      <Section dense title="互动" description="选项、HUD 和存档（VN4）">
        <SwitchField
          label="显示选项"
          hint="模型给出的 <choices> 显示成按钮，点一下就发出去"
          checked={interaction.choices}
          onChange={(v) => set('interaction', 'choices', v)}
        />
        <SwitchField
          label="有选项时仍显示输入框"
          hint={later('VN4', 'VN 视图里有选项时，是否还能自由输入')}
          notImplemented
          checked={interaction.inputWithChoices}
          onChange={(v) => set('interaction', 'inputWithChoices', v)}
        />
        <SelectField
          label="选项排列"
          hint={later('VN4', 'VN 视图里选项按钮的排法')}
          notImplemented
          value={interaction.choiceLayout}
          onChange={(v) => set('interaction', 'choiceLayout', v)}
          options={[
            { value: 'auto', label: '自动' },
            { value: 'row', label: '横排' },
            { value: 'column', label: '竖排' },
          ]}
        />
        <SwitchField
          label="显示 HUD"
          hint={later('VN4', '在画面上显示状态面板（好感、HP……）')}
          notImplemented
          checked={interaction.hud}
          onChange={(v) => set('interaction', 'hud', v)}
        />
        <SelectField
          label="HUD 位置"
          hint={later('VN4', '手机上总是顶部一行')}
          notImplemented
          value={interaction.hudPosition}
          onChange={(v) => set('interaction', 'hudPosition', v)}
          options={[
            { value: 'top-right', label: '右上' },
            { value: 'top-left', label: '左上' },
            { value: 'top-bar', label: '顶部一行' },
          ]}
        />
        <SwitchField
          label="数值变化飘字"
          hint={later('VN4', '变量变化时显示 +2 / −5')}
          notImplemented
          checked={interaction.floatDelta}
          onChange={(v) => set('interaction', 'floatDelta', v)}
        />
        <SwitchField
          label="阶段变化触发世界书"
          hint={later('VN4', '数值跨过阶段阈值时（比如好感到「心动」）触发对应的世界书条目')}
          notImplemented
          checked={interaction.stageLore}
          onChange={(v) => set('interaction', 'stageLore', v)}
        />
        <SwitchField
          label="存档缩略图"
          hint={later('VN4', '存档时保存一张画面缩略图')}
          notImplemented
          checked={interaction.saveThumb}
          onChange={(v) => set('interaction', 'saveThumb', v)}
        />
      </Section>

      <Section dense title="音频" description="BGM、音效和语音，以后做，现在先留好设置" defaultOpen={false}>
        <SwitchField
          label="启用 BGM"
          hint={later('以后', '按场景指令播放背景音乐')}
          notImplemented
          checked={audio.bgm}
          onChange={(v) => set('audio', 'bgm', v)}
        />
        <NumberField
          label="BGM 音量"
          notImplemented
          min={0}
          max={100}
          value={audio.bgmVolume}
          onChange={(v) => set('audio', 'bgmVolume', Math.round(v))}
        />
        <NumberField
          label="音效音量"
          notImplemented
          min={0}
          max={100}
          value={audio.sfxVolume}
          onChange={(v) => set('audio', 'sfxVolume', Math.round(v))}
        />
        <NumberField
          label="语音音量"
          notImplemented
          min={0}
          max={100}
          value={audio.voiceVolume}
          onChange={(v) => set('audio', 'voiceVolume', Math.round(v))}
        />
        <NumberField
          label="淡入淡出（毫秒）"
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

/** 指令说明模板：留空用默认模板；可以一键填入默认模板再改 */
function TemplateField({
  value,
  style,
  disabled,
  onChange,
}: {
  value: string
  style: 'shorthand' | 'xml'
  disabled: boolean
  onChange: (v: string) => void
}) {
  return (
    <div className="col-span-full space-y-1">
      <TextAreaField
        label="指令说明模板"
        hint="留空用默认模板。可用占位符：{{vn_kinds}} 指令写法、{{vn_cast}} 角色、{{vn_expressions}} 表情、{{vn_backgrounds}} 背景、{{vn_state}} 变量；为空的占位符所在的行会被整行去掉"
        disabled={disabled}
        mono
        rows={value ? 8 : 3}
        placeholder={`（使用默认模板）\n${DEFAULT_DIRECTIVE_TEMPLATES[style].split('\n').slice(0, 2).join('\n')}…`}
        value={value}
        onChange={onChange}
      />
      <div className="flex justify-end gap-1.5">
        {value && (
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange('')}>
            恢复默认
          </Button>
        )}
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => {
            if (!value || confirm('用默认模板覆盖当前内容？')) onChange(DEFAULT_DIRECTIVE_TEMPLATES[style])
          }}
        >
          填入默认模板
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
    return { count: 0, error: `不是合法的 JSON：${e instanceof Error ? e.message : String(e)}` }
  }
  const parsed = stateSchemaSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { count: 0, error: `格式不对：${issue?.path.join('.') || '根'} ${issue?.message ?? ''}` }
  }
  return { count: Object.keys(parsed.data).length }
}
