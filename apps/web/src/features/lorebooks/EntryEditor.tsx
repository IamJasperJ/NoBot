import {
  GENERATION_TYPE_LABELS,
  type GenerationType,
  type LorebookEntryData,
  type MatchSource,
  WI_POSITION_LABELS,
  type WIPosition,
} from '@ai-parter/shared'
import {
  ListField,
  NumberField,
  Section,
  SelectField,
  SwitchField,
  TextAreaField,
  TextField,
} from '../../components/form'
import { Button, controlClass, Field } from '../../components/ui'
import { SaveActions } from './editor'

const sources: Record<MatchSource, string> = {
  char_description: '角色描述',
  char_personality: '角色性格',
  scenario: '场景',
  persona: '用户人设',
  char_note: '角色备注',
  creator_notes: '作者备注',
}

function Checks<T extends string>({
  label,
  hint,
  labels,
  value,
  onChange,
}: {
  label: string
  hint: string
  labels: Record<T, string>
  value: T[]
  onChange: (value: T[]) => void
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-3">
        {(Object.keys(labels) as T[]).map((key) => (
          <label key={key} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-violet-600"
              checked={value.includes(key)}
              onChange={(e) => onChange(e.target.checked ? [...value, key] : value.filter((v) => v !== key))}
            />
            {labels[key]}
          </label>
        ))}
      </div>
      <p className="text-xs text-zinc-500">{hint}</p>
    </fieldset>
  )
}

export function EntryEditor({
  draft,
  onChange,
  dirty,
  pending,
  save,
  reset,
  remove,
}: {
  draft: LorebookEntryData
  onChange: (draft: LorebookEntryData) => void
  dirty: boolean
  pending: boolean
  save: () => void
  reset: () => void
  remove: () => void
}) {
  const set = <K extends keyof LorebookEntryData>(key: K, value: LorebookEntryData[K]) =>
    onChange({ ...draft, [key]: value })
  const number = (
    key: keyof { [K in keyof LorebookEntryData as LorebookEntryData[K] extends number ? K : never]: number },
    label: string,
    hint: string,
    min = 0,
    max = Number.MAX_SAFE_INTEGER,
    notImplemented = false,
  ) => (
    <NumberField
      label={label}
      hint={hint}
      value={draft[key]}
      onChange={(v) => set(key, v)}
      min={min}
      max={max}
      slider={false}
      notImplemented={notImplemented}
    />
  )
  const toggle = (
    key: keyof { [K in keyof LorebookEntryData as LorebookEntryData[K] extends boolean ? K : never]: boolean },
    label: string,
    hint: string,
    notImplemented = false,
  ) => (
    <SwitchField
      label={label}
      hint={hint}
      checked={draft[key]}
      onChange={(v) => set(key, v)}
      notImplemented={notImplemented}
    />
  )
  return (
    <fieldset disabled={pending} className="min-w-0 space-y-4 border-t border-zinc-200 p-3 sm:p-4 dark:border-zinc-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SaveActions dirty={dirty} pending={pending} save={save} reset={reset} />
        <Button variant="danger" disabled={pending} onClick={remove}>
          删除条目
        </Button>
      </div>
      <Section title="基本">
        <TextField
          label="备注"
          hint="仅用于辨认条目，不会发送给模型。"
          value={draft.comment}
          onChange={(v) => set('comment', v)}
        />
        <ListField
          label="主关键词"
          hint="以 / 开头和结尾的按正则匹配，例如 /龙(族|人)/i"
          value={draft.keys}
          onChange={(v) => set('keys', v)}
        />
        <TextAreaField
          label="内容"
          hint="条目激活时，将这段设定插入发送给模型的提示词中。"
          rows={6}
          value={draft.content}
          onChange={(v) => set('content', v)}
        />
        <p className="text-xs text-zinc-500">字数：{Array.from(draft.content).length}</p>
      </Section>
      <Section title="触发">
        {toggle('constant', '常驻条目', '开启后无需命中关键词也会参与激活，仍受概率、过滤和预算等限制。')}
        <ListField
          label="可选过滤关键词"
          hint="主关键词命中后，再按下面的组合逻辑检查这些关键词。"
          value={draft.secondaryKeys}
          onChange={(v) => set('secondaryKeys', v)}
        />
        <SelectField
          label="过滤关键词逻辑"
          hint="规定额外的关键词需要满足哪种条件；未填写过滤关键词时不额外限制。"
          value={draft.selectiveLogic}
          onChange={(v) => set('selectiveLogic', v)}
          options={[
            { value: 'and_any', label: '包含任意一个' },
            { value: 'and_all', label: '包含全部' },
            { value: 'not_any', label: '一个都不包含' },
            { value: 'not_all', label: '不全部包含' },
          ]}
        />
        {toggle('useProbability', '使用触发概率', '开启后，每次满足触发条件时还要按下方概率判定。')}
        {number('probability', '触发概率（%）', '100 表示每次通过，0 表示不会通过概率判定。', 0, 100)}
        {number('delay', '延迟消息数', '聊天中至少有这么多条消息时，条目才允许触发。')}
        <Checks<GenerationType>
          label="生成类型"
          hint="只在勾选的生成类型下触发，都不选表示全部类型。"
          labels={GENERATION_TYPE_LABELS}
          value={draft.triggers}
          onChange={(v) => set('triggers', v)}
        />
        <ListField
          label="角色过滤名单"
          hint="只对名单中的角色名生效；名单为空时不限制角色。"
          value={draft.characterFilter.names}
          onChange={(v) => set('characterFilter', { ...draft.characterFilter, names: v })}
        />
        <SwitchField
          label="排除模式"
          hint="开启后，名单中的角色被排除，其他角色可以触发条目。"
          checked={draft.characterFilter.exclude}
          onChange={(v) => set('characterFilter', { ...draft.characterFilter, exclude: v })}
        />
      </Section>
      <Section title="插入">
        <SelectField<WIPosition>
          label="插入位置"
          hint="决定内容放在提示词的哪个位置；宏引用需要在 Prompt 中手动引用。"
          value={draft.position}
          onChange={(v) => set('position', v)}
          options={(Object.keys(WI_POSITION_LABELS) as WIPosition[]).map((value) => ({
            value,
            label: WI_POSITION_LABELS[value],
          }))}
        />
        {draft.position === 'at_depth' && (
          <>
            {number('depth', '插入深度', '从聊天记录末尾向前数，0 表示放在最新消息之后。', 0, 9999)}
            <SelectField
              label="消息角色"
              hint="将插入内容作为哪一种角色的消息发送给模型。"
              value={draft.role}
              onChange={(v) => set('role', v)}
              options={[
                { value: 'system', label: '系统' },
                { value: 'user', label: '用户' },
                { value: 'assistant', label: '助手' },
              ]}
            />
          </>
        )}
        {draft.position === 'outlet' && (
          <TextField
            label="宏引用名字"
            hint="在 Prompt 里用 {{outlet::名字}} 引用"
            value={draft.outletName}
            onChange={(v) => set('outletName', v)}
          />
        )}
        {number('order', '插入顺序', '数字大的更靠后、离生成位置更近，预算不够时也优先保留', Number.MIN_SAFE_INTEGER)}
      </Section>
      <Section title="匹配">
        {(['caseSensitive', 'matchWholeWords'] as const).map((key) => (
          <SelectField
            key={key}
            label={key === 'caseSensitive' ? '区分大小写' : '完整单词匹配'}
            hint={
              key === 'caseSensitive'
                ? '控制英文关键词是否区分大小写，跟随全局会使用全局激活设置。'
                : '只匹配完整单词，跟随全局会使用全局激活设置。'
            }
            value={draft[key] === null ? 'inherit' : String(draft[key])}
            onChange={(v) => set(key, v === 'inherit' ? null : v === 'true')}
            options={[
              { value: 'inherit', label: '跟随全局' },
              { value: 'true', label: '是' },
              { value: 'false', label: '否' },
            ]}
          />
        ))}
        <Field label="扫描深度" hint="扫描最近多少条消息（0–1000）；留空表示跟随全局。">
          <input
            className={controlClass}
            type="number"
            min={0}
            max={1000}
            step={1}
            placeholder="跟随全局"
            value={draft.scanDepth ?? ''}
            onChange={(e) => set('scanDepth', e.target.value === '' ? null : Number(e.target.value))}
          />
        </Field>
        <Checks<MatchSource>
          label="额外匹配来源"
          hint="除聊天消息外，也扫描勾选的角色与人设资料来匹配关键词。"
          labels={sources}
          value={draft.matchSources}
          onChange={(v) => set('matchSources', v)}
        />
      </Section>
      <Section title="递归">
        {toggle('excludeRecursion', '排除递归触发', '不会被其他条目的内容触发，仍可通过聊天记录触发。')}
        {toggle('preventRecursion', '阻止后续递归', '本条目触发后，其内容不会再触发其他条目。')}
        {toggle('delayUntilRecursion', '仅在递归时触发', '只参与递归扫描，不参与最初的聊天记录扫描。')}
      </Section>
      <Section title="包含组">
        <TextField
          label="包含组"
          hint="逗号分隔可属于多个组；同组多个条目同时触发时只保留一个"
          value={draft.group}
          onChange={(v) => set('group', v)}
        />
        {toggle('groupPrioritize', '组内按顺序优先', '开启后保留插入顺序数字最大的条目，否则按权重随机选择。')}
        {number('groupWeight', '组内权重', '按权重随机选择时，数字越大，被保留的机会越高。', 1)}
        {toggle('groupScoring', '组内计分', '组内使用匹配分数选择条目；目前只保存，暂不生效。', true)}
      </Section>
      <Section title="暂未实现" description="这些字段可以保存和导入导出，但当前扫描时不会生效。" defaultOpen={false}>
        {number('sticky', '粘滞消息数', '触发后持续生效多少条消息，0 表示不持续。', 0, Number.MAX_SAFE_INTEGER, true)}
        {number(
          'cooldown',
          '冷却消息数',
          '触发后多少条消息内不允许再次触发，0 表示不冷却。',
          0,
          Number.MAX_SAFE_INTEGER,
          true,
        )}
        <TextField
          label="自动化标识"
          hint="供快捷回复等自动化脚本关联此条目，目前暂不执行。"
          notImplemented
          value={draft.automationId}
          onChange={(v) => set('automationId', v)}
        />
        {toggle('vectorized', '向量匹配', '通过语义相似度匹配条目，目前暂不生效。', true)}
      </Section>
    </fieldset>
  )
}
