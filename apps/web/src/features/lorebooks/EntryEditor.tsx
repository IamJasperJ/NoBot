import type { GenerationType, LorebookEntryData, MatchSource, WIPosition } from '@ai-parter/shared'
import { useId } from 'react'
import { useBackgrounds } from '../../api/queries'
import {
  DenseRow,
  denseControlClass,
  ListField,
  NumberField,
  Section,
  SelectField,
  SwitchField,
  TextAreaField,
  TextField,
} from '../../components/form'
import { Button, cx } from '../../components/ui'
import { t } from '../../i18n'
import { generationTypeLabels, wiPositionLabels } from '../../i18n-labels'
import { SaveActions } from './editor'

const sources = (): Record<MatchSource, string> => ({
  char_description: t('角色描述'),
  char_personality: t('角色性格'),
  scenario: t('场景'),
  persona: t('用户人设'),
  char_note: t('角色备注'),
  creator_notes: t('作者备注'),
})

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
    <DenseRow label={label} hint={hint} wide>
      <fieldset aria-label={label} className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1 py-1.5">
        {(Object.keys(labels) as T[]).map((key) => (
          <label key={key} className="flex items-center gap-1.5 text-[13px]">
            <input
              type="checkbox"
              className="accent-violet-600"
              checked={value.includes(key)}
              onChange={(e) => onChange(e.target.checked ? [...value, key] : value.filter((v) => v !== key))}
            />
            {labels[key]}
          </label>
        ))}
      </fieldset>
    </DenseRow>
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
  ) => (
    <NumberField
      label={label}
      hint={hint}
      value={draft[key]}
      onChange={(v) => set(key, v)}
      min={min}
      max={max}
      slider={false}
    />
  )
  const scanDepthId = useId()
  const backgrounds = useBackgrounds()
  const toggle = (
    key: keyof { [K in keyof LorebookEntryData as LorebookEntryData[K] extends boolean ? K : never]: boolean },
    label: string,
    hint: string,
  ) => <SwitchField label={label} hint={hint} checked={draft[key]} onChange={(v) => set(key, v)} />
  return (
    <fieldset disabled={pending} className="min-w-0 space-y-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SaveActions dirty={dirty} pending={pending} save={save} reset={reset} />
        <Button variant="danger" disabled={pending} onClick={remove}>
          {t('删除条目')}
        </Button>
      </div>
      <Section dense title={t('基本')}>
        <TextField
          label={t('备注')}
          hint={t('仅用于辨认条目，不会发送给模型。')}
          value={draft.comment}
          onChange={(v) => set('comment', v)}
        />
        <ListField
          label={t('主关键词')}
          hint={t('以 / 开头和结尾的按正则匹配，例如 /龙(族|人)/i')}
          value={draft.keys}
          onChange={(v) => set('keys', v)}
        />
        <TextAreaField
          label={t('内容')}
          hint={t('条目激活时，将这段设定插入发送给模型的提示词中。')}
          rows={6}
          value={draft.content}
          onChange={(v) => set('content', v)}
        />
        <p className="col-span-full -mt-0.5 text-right text-xs text-zinc-400">
          {t('字数：{count}', { count: Array.from(draft.content).length })}
        </p>
        <SelectField
          label={t('切换到背景')}
          hint={t('条目被触发时把会话背景换成这张（需要在会话设置里打开「世界书条目触发时换背景」）')}
          value={draft.backgroundId ?? ''}
          options={[
            { value: '', label: t('不切换') },
            ...(backgrounds.data ?? []).map((b) => ({ value: b.id, label: b.name })),
          ]}
          onChange={(id) => set('backgroundId', id || null)}
        />
      </Section>
      <Section dense title={t('触发')}>
        {toggle('constant', t('常驻条目'), t('开启后无需命中关键词也会参与激活，仍受概率、过滤和预算等限制。'))}
        <ListField
          label={t('可选过滤关键词')}
          hint={t('主关键词命中后，再按下面的组合逻辑检查这些关键词。')}
          value={draft.secondaryKeys}
          onChange={(v) => set('secondaryKeys', v)}
        />
        <SelectField
          label={t('过滤关键词逻辑')}
          hint={t('规定额外的关键词需要满足哪种条件；未填写过滤关键词时不额外限制。')}
          value={draft.selectiveLogic}
          onChange={(v) => set('selectiveLogic', v)}
          options={[
            { value: 'and_any', label: t('包含任意一个') },
            { value: 'and_all', label: t('包含全部') },
            { value: 'not_any', label: t('一个都不包含') },
            { value: 'not_all', label: t('不全部包含') },
          ]}
        />
        {toggle('useProbability', t('使用触发概率'), t('开启后，每次满足触发条件时还要按下方概率判定。'))}
        {number('probability', t('触发概率（%）'), t('100 表示每次通过，0 表示不会通过概率判定。'), 0, 100)}
        {number('delay', t('延迟消息数'), t('聊天中至少有这么多条消息时，条目才允许触发。'))}
        <Checks<GenerationType>
          label={t('生成类型')}
          hint={t('只在勾选的生成类型下触发，都不选表示全部类型。')}
          labels={generationTypeLabels()}
          value={draft.triggers}
          onChange={(v) => set('triggers', v)}
        />
        <ListField
          label={t('角色过滤名单')}
          hint={t('只对名单中的角色名生效；名单为空时不限制角色。')}
          value={draft.characterFilter.names}
          onChange={(v) => set('characterFilter', { ...draft.characterFilter, names: v })}
        />
        <SwitchField
          label={t('排除模式')}
          hint={t('开启后，名单中的角色被排除，其他角色可以触发条目。')}
          checked={draft.characterFilter.exclude}
          onChange={(v) => set('characterFilter', { ...draft.characterFilter, exclude: v })}
        />
      </Section>
      <Section dense title={t('插入')}>
        <SelectField<WIPosition>
          label={t('插入位置')}
          hint={t('决定内容放在提示词的哪个位置；宏引用需要在 Prompt 中手动引用。')}
          value={draft.position}
          onChange={(v) => set('position', v)}
          options={(Object.keys(wiPositionLabels()) as WIPosition[]).map((value) => ({
            value,
            label: wiPositionLabels()[value],
          }))}
        />
        {draft.position === 'at_depth' && (
          <>
            {number('depth', t('插入深度'), t('从聊天记录末尾向前数，0 表示放在最新消息之后。'), 0, 9999)}
            <SelectField
              label={t('消息角色')}
              hint={t('将插入内容作为哪一种角色的消息发送给模型。')}
              value={draft.role}
              onChange={(v) => set('role', v)}
              options={[
                { value: 'system', label: t('系统') },
                { value: 'user', label: t('用户') },
                { value: 'assistant', label: t('助手') },
              ]}
            />
          </>
        )}
        {draft.position === 'outlet' && (
          <TextField
            label={t('宏引用名字')}
            hint={t('在 Prompt 里用 {{outlet::名字}} 引用')}
            value={draft.outletName}
            onChange={(v) => set('outletName', v)}
          />
        )}
        {number(
          'order',
          t('插入顺序'),
          t('数字大的更靠后、离生成位置更近，预算不够时也优先保留'),
          Number.MIN_SAFE_INTEGER,
        )}
      </Section>
      <Section dense title={t('匹配')}>
        {(['caseSensitive', 'matchWholeWords'] as const).map((key) => (
          <SelectField
            key={key}
            label={key === 'caseSensitive' ? t('区分大小写') : t('完整单词匹配')}
            hint={
              key === 'caseSensitive'
                ? t('控制英文关键词是否区分大小写，跟随全局会使用全局激活设置。')
                : t('只匹配完整单词，跟随全局会使用全局激活设置。')
            }
            value={draft[key] === null ? 'inherit' : String(draft[key])}
            onChange={(v) => set(key, v === 'inherit' ? null : v === 'true')}
            options={[
              { value: 'inherit', label: t('跟随全局') },
              { value: 'true', label: t('是') },
              { value: 'false', label: t('否') },
            ]}
          />
        ))}
        <DenseRow id={scanDepthId} label={t('扫描深度')} hint={t('扫描最近多少条消息（0–1000）；留空表示跟随全局。')}>
          <input
            id={scanDepthId}
            className={cx(denseControlClass, 'w-28 shrink-0 px-1.5 text-right tabular-nums')}
            type="number"
            min={0}
            max={1000}
            step={1}
            placeholder={t('跟随全局')}
            value={draft.scanDepth ?? ''}
            onChange={(e) => set('scanDepth', e.target.value === '' ? null : Number(e.target.value))}
          />
        </DenseRow>
        <Checks<MatchSource>
          label={t('额外匹配来源')}
          hint={t('除聊天消息外，也扫描勾选的角色与人设资料来匹配关键词。')}
          labels={sources()}
          value={draft.matchSources}
          onChange={(v) => set('matchSources', v)}
        />
      </Section>
      <Section dense title={t('递归')}>
        {toggle('excludeRecursion', t('排除递归触发'), t('不会被其他条目的内容触发，仍可通过聊天记录触发。'))}
        {toggle('preventRecursion', t('阻止后续递归'), t('本条目触发后，其内容不会再触发其他条目。'))}
        {toggle('delayUntilRecursion', t('仅在递归时触发'), t('只参与递归扫描，不参与最初的聊天记录扫描。'))}
      </Section>
      <Section dense title={t('包含组')}>
        <TextField
          label={t('包含组')}
          hint={t('逗号分隔可属于多个组；同组多个条目同时触发时只保留一个')}
          value={draft.group}
          onChange={(v) => set('group', v)}
        />
        {toggle('groupPrioritize', t('组内按顺序优先'), t('开启后保留插入顺序数字最大的条目，否则按权重随机选择。'))}
        {number('groupWeight', t('组内权重'), t('按权重随机选择时，数字越大，被保留的机会越高。'), 1)}
        {toggle('groupScoring', t('组内计分'), t('组内使用匹配分数选择条目。'))}
      </Section>
      <Section dense title={t('定时效果与自动化')} defaultOpen={false}>
        {number('sticky', t('粘滞消息数'), t('触发后持续生效多少条消息，0 表示不持续。'), 0, Number.MAX_SAFE_INTEGER)}
        {number(
          'cooldown',
          t('冷却消息数'),
          t('触发后多少条消息内不允许再次触发，0 表示不冷却。'),
          0,
          Number.MAX_SAFE_INTEGER,
        )}
        <TextField
          label={t('自动化标识')}
          hint={t('供快捷回复等自动化脚本关联此条目。')}
          value={draft.automationId}
          onChange={(v) => set('automationId', v)}
        />
        {toggle('vectorized', t('向量匹配'), t('通过语义相似度匹配条目。'))}
      </Section>
    </fieldset>
  )
}
