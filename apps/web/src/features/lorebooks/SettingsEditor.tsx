import { type WorldInfoSettings, worldInfoSettingsSchema } from '@ai-parter/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { keys } from '../../api/queries'
import { NumberField, Section, SelectField, SwitchField } from '../../components/form'
import { DetailHeader } from '../../components/layout'
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
      toast.error('请检查设置：数字必须为范围内的整数')
      return
    }
    setPending(true)
    try {
      const saved = await api.setWorldInfoSettings(parsed.data)
      setBase(saved)
      setDraft(structuredClone(saved))
      await qc.invalidateQueries({ queryKey: keys.worldInfoSettings })
      toast.info('全局激活设置已保存')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setPending(false)
    }
  }
  return (
    <>
      <DetailHeader
        title="全局激活设置"
        onBack={onBack}
        actions={
          <SaveActions dirty={dirty} pending={pending} save={save} reset={() => setDraft(structuredClone(base))} />
        }
      />
      <fieldset disabled={pending} className="mx-auto min-w-0 max-w-4xl space-y-4 p-4">
        <Section title="扫描与预算">
          <NumberField
            label="扫描深度"
            hint="扫描最近多少条聊天消息，0 表示不扫描聊天记录。"
            value={draft.scanDepth}
            onChange={(v) => set('scanDepth', v)}
            min={0}
            max={1000}
          />
          <NumberField
            label="预算比例（%）"
            hint="世界书内容最多占上下文长度的百分比。"
            value={draft.budgetPercent}
            onChange={(v) => set('budgetPercent', v)}
            min={1}
            max={100}
          />
          <NumberField
            label="预算上限（token）"
            hint="限制世界书使用的 token 数，0 表示不额外限制。"
            value={draft.budgetCap}
            onChange={(v) => set('budgetCap', v)}
            min={0}
            max={Number.MAX_SAFE_INTEGER}
            slider={false}
          />
          <SwitchField
            label="包含发言人名字"
            hint="匹配前在每条消息前加上发言人名字，使名字也能触发关键词。"
            checked={draft.includeNames}
            onChange={(v) => set('includeNames', v)}
          />
        </Section>
        <Section title="匹配与递归">
          <SwitchField
            label="区分大小写"
            hint="开启后，英文关键词的大小写必须与文本一致。"
            checked={draft.caseSensitive}
            onChange={(v) => set('caseSensitive', v)}
          />
          <SwitchField
            label="完整单词匹配"
            hint="开启后，只匹配完整单词，避免关键词命中更长单词的一部分。"
            checked={draft.matchWholeWords}
            onChange={(v) => set('matchWholeWords', v)}
          />
          <SwitchField
            label="递归扫描"
            hint="继续扫描已激活条目的内容，让其中的关键词触发其他条目。"
            checked={draft.recursive}
            onChange={(v) => set('recursive', v)}
          />
          <NumberField
            label="最大递归轮数"
            hint="限制递归扫描轮数，0 表示不额外限制，实际最多 10 轮。"
            value={draft.maxRecursionSteps}
            onChange={(v) => set('maxRecursionSteps', v)}
            min={0}
            max={10}
          />
        </Section>
        <Section title="插入策略">
          <SelectField
            label="多个来源的排序方式"
            hint="决定角色世界书和全局世界书的条目在提示词中如何排列。"
            value={draft.insertionStrategy}
            onChange={(v) => set('insertionStrategy', v)}
            options={[
              { value: 'evenly', label: '均匀排序：混合角色与全局条目，按插入顺序排列' },
              { value: 'character_first', label: '角色优先：角色世界书条目排在全局条目之前' },
              { value: 'global_first', label: '全局优先：全局世界书条目排在角色条目之前' },
            ]}
          />
          <NumberField
            label="最少激活数"
            hint="期望至少激活的条目数量；目前仅保存设置，扫描时暂不生效。"
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
