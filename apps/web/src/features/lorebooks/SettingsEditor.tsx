import { type WorldInfoSettings, worldInfoSettingsSchema } from '@nobot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { keys, useConnections } from '../../api/queries'
import { NumberField, Section, SelectField, SwitchField, TextField } from '../../components/form'
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
  const connections = useConnections()
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
            hint={t('限制递归扫描轮数，0 表示扫描至收敛。')}
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
            hint={t('期望至少激活的条目数量；不足时扩大扫描深度。')}
            value={draft.minActivations}
            onChange={(v) => set('minActivations', v)}
            min={0}
            max={Number.MAX_SAFE_INTEGER}
            slider={false}
          />
          <NumberField
            label={t('最大扫描深度')}
            hint={t('为凑够「最少激活数」往前扫描的最多消息数，0 表示可以扫到最早的消息')}
            value={draft.maxDepth}
            onChange={(v) => set('maxDepth', Math.round(v))}
            min={0}
            max={1000}
            slider={false}
          />
        </Section>
        <Section
          dense
          title={t('向量匹配')}
          description={t('按意思相近触发条目（对应酒馆的 Vector Storage），只对勾了「向量匹配」的条目生效')}
        >
          <SwitchField
            label={t('启用向量匹配')}
            hint={t('每次生成会把最近几条消息和条目内容做向量比较；条目内容的向量会缓存，改了才重新计算')}
            checked={draft.vectorEnabled}
            onChange={(v) => set('vectorEnabled', v)}
          />
          <SelectField
            label={t('向量接口')}
            hint={t('用哪个连接的 /embeddings 接口（OpenAI 兼容）')}
            disabled={!draft.vectorEnabled}
            value={draft.embeddingConnectionId ?? ''}
            onChange={(v) => set('embeddingConnectionId', v || null)}
            options={[
              { value: '', label: t('选择连接') },
              ...(connections.data ?? []).map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          <TextField
            label={t('向量模型')}
            hint={t('例如 text-embedding-3-small；换模型后所有条目会重新计算')}
            disabled={!draft.vectorEnabled}
            value={draft.embeddingModel}
            onChange={(v) => set('embeddingModel', v.trim())}
          />
          <NumberField
            label={t('相似度阈值')}
            hint={t('0–1，越高越严格。一般 0.2–0.4')}
            disabled={!draft.vectorEnabled}
            value={draft.vectorThreshold}
            onChange={(v) => set('vectorThreshold', v)}
            min={0}
            max={1}
            step={0.05}
          />
          <NumberField
            label={t('最多命中条目')}
            hint={t('每次最多按向量触发几条，0 表示不限')}
            disabled={!draft.vectorEnabled}
            value={draft.vectorMaxEntries}
            onChange={(v) => set('vectorMaxEntries', Math.round(v))}
            min={0}
            max={100}
            slider={false}
          />
          <NumberField
            label={t('查询用的消息数')}
            hint={t('拿最近几条消息去比较')}
            disabled={!draft.vectorEnabled}
            value={draft.vectorQueryMessages}
            onChange={(v) => set('vectorQueryMessages', Math.round(v))}
            min={1}
            max={20}
            slider={false}
          />
        </Section>
      </fieldset>
    </>
  )
}
