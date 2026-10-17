import { type WorldInfoSettings, worldInfoSettingsSchema } from '@ai-parter/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { keys } from '../../api/queries'
import { NumberField, Section, SelectField, SwitchField } from '../../components/form'
import { DetailHeader } from '../../components/layout'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'
import { isDifferent, type LeaveGuard, SaveActions, useLeaveGuard } from './editor'

export function SettingsEditor({
  settings,
  guard,
  onBack,
}: {
  settings: WorldInfoSettings
  guard: LeaveGuard
  onBack: () => void
}) {
  const qc = useQueryClient()
  const [base, setBase] = useState(settings)
  const [draft, setDraft] = useState(() => structuredClone(settings))
  const [pending, setPending] = useState(false)
  const dirty = isDifferent(draft, base)
  useLeaveGuard(guard, dirty, pending)
  const set = <K extends keyof WorldInfoSettings>(key: K, value: WorldInfoSettings[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))
  const save = async () => {
    const parsed = worldInfoSettingsSchema.safeParse(draft)
    if (!parsed.success) {
      toast.error(t('请检查设置：数字必须为范围内的整数'))
      return
    }
    setPending(true)
    try {
      const saved = await api.setWorldInfoSettings(parsed.data)
      setBase(saved)
      setDraft(structuredClone(saved))
      await qc.invalidateQueries({ queryKey: keys.worldInfoSettings })
      toast.info(t('全局激活设置已保存'))
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setPending(false)
    }
  }
  return (
    <>
      <DetailHeader
        title={t('全局激活设置')}
        onBack={onBack}
        actions={
          <SaveActions dirty={dirty} pending={pending} save={save} reset={() => setDraft(structuredClone(base))} />
        }
      />
      <fieldset disabled={pending} className="mx-auto min-w-0 max-w-6xl space-y-2 p-3">
        <Section dense title={t('扫描与预算')}>
          <NumberField
            label={t('扫描深度')}
            hint={t('扫描最近多少条聊天消息，0 表示不扫描聊天记录。')}
            value={draft.scanDepth}
            onChange={(v) => set('scanDepth', v)}
            min={0}
            max={1000}
          />
          <NumberField
            label={t('预算比例（%）')}
            hint={t('世界书内容最多占上下文长度的百分比。')}
            value={draft.budgetPercent}
            onChange={(v) => set('budgetPercent', v)}
            min={1}
            max={100}
          />
          <NumberField
            label={t('预算上限（token）')}
            hint={t('限制世界书使用的 token 数，0 表示不额外限制。')}
            value={draft.budgetCap}
            onChange={(v) => set('budgetCap', v)}
            min={0}
            max={Number.MAX_SAFE_INTEGER}
            slider={false}
          />
          <SwitchField
            label={t('包含发言人名字')}
            hint={t('匹配前在每条消息前加上发言人名字，使名字也能触发关键词。')}
            checked={draft.includeNames}
            onChange={(v) => set('includeNames', v)}
          />
        </Section>
        <Section dense title={t('匹配与递归')}>
          <SwitchField
            label={t('区分大小写')}
            hint={t('开启后，英文关键词的大小写必须与文本一致。')}
            checked={draft.caseSensitive}
            onChange={(v) => set('caseSensitive', v)}
          />
          <SwitchField
            label={t('完整单词匹配')}
            hint={t('开启后，只匹配完整单词，避免关键词命中更长单词的一部分。')}
            checked={draft.matchWholeWords}
            onChange={(v) => set('matchWholeWords', v)}
          />
          <SwitchField
            label={t('递归扫描')}
            hint={t('继续扫描已激活条目的内容，让其中的关键词触发其他条目。')}
            checked={draft.recursive}
            onChange={(v) => set('recursive', v)}
          />
          <NumberField
            label={t('最大递归轮数')}
            hint={t('限制递归扫描轮数，0 表示不额外限制，实际最多 10 轮。')}
            value={draft.maxRecursionSteps}
            onChange={(v) => set('maxRecursionSteps', v)}
            min={0}
            max={10}
          />
        </Section>
        <Section dense title={t('插入策略')}>
          <SelectField
            label={t('多个来源的排序方式')}
            hint={t('决定角色世界书和全局世界书的条目在提示词中如何排列。')}
            value={draft.insertionStrategy}
            onChange={(v) => set('insertionStrategy', v)}
            options={[
              { value: 'evenly', label: t('均匀排序：混合角色与全局条目，按插入顺序排列') },
              { value: 'character_first', label: t('角色优先：角色世界书条目排在全局条目之前') },
              { value: 'global_first', label: t('全局优先：全局世界书条目排在角色条目之前') },
            ]}
          />
          <NumberField
            label={t('最少激活数')}
            hint={t('期望至少激活的条目数量；目前仅保存设置，扫描时暂不生效。')}
            notImplemented
            value={draft.minActivations}
            onChange={(v) => set('minActivations', v)}
            min={0}
            max={Number.MAX_SAFE_INTEGER}
            slider={false}
          />
        </Section>
      </fieldset>
    </>
  )
}
