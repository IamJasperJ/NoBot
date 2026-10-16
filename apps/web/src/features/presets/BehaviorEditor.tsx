import type { PresetBehavior } from '@ai-parter/shared'
import { Section, SelectField, SwitchField, TextAreaField } from '../../components/form'

export function BehaviorEditor({ value, onChange }: { value: PresetBehavior; onChange: (v: PresetBehavior) => void }) {
  const set = <K extends keyof PresetBehavior>(key: K, v: PresetBehavior[K]) => onChange({ ...value, [key]: v })
  return (
    <div className="space-y-2">
      <Section dense title="消息格式">
        <SelectField
          label="角色名发送方式"
          hint="控制名字放在哪里；name 字段只支持英文数字，不合法的名字会退回文字前缀。"
          value={value.namesBehavior}
          onChange={(v) => set('namesBehavior', v)}
          options={[
            { value: 'none', label: '不加名字' },
            { value: 'default', label: '默认（只在群聊里加前缀）' },
            { value: 'completion', label: '放进 name 字段（只支持英文名）' },
            { value: 'content', label: '总是加「名字: 」前缀' },
          ]}
        />
        <SwitchField
          label="合并系统消息"
          hint="合并连续的 system 消息，示例对话除外。"
          checked={value.squashSystem}
          onChange={(v) => set('squashSystem', v)}
        />
        <SelectField
          label="消息后处理"
          hint="根据接口要求整理消息角色和顺序；严格模式还会确保第一条非系统消息来自用户。"
          value={value.postProcessing}
          onChange={(v) => set('postProcessing', v)}
          options={[
            { value: 'none', label: '不处理（保留原始消息）' },
            { value: 'merge', label: '合并相邻同角色消息' },
            { value: 'semi_strict', label: '半严格（合并，后续系统消息改为用户）' },
            { value: 'strict', label: '严格（半严格，并确保用户先发言）' },
            { value: 'single_user', label: '合成一条用户消息' },
          ]}
        />
        <SwitchField
          label="用户消息加引号"
          hint="把用户消息包在引号里；暂未实现，建议用正则扩展。"
          notImplemented
          checked={value.wrapInQuotes}
          onChange={(v) => set('wrapInQuotes', v)}
        />
        <SwitchField
          label="独立系统指令字段"
          hint="供 Claude / Gemini 原生接口使用，暂未实现。"
          notImplemented
          checked={value.useSystemPrompt}
          onChange={(v) => set('useSystemPrompt', v)}
        />
      </Section>
      <Section dense title="续写与预填充">
        <SwitchField
          label="续写使用预填充"
          hint="把原消息作为 assistant 预填充发送，替代辅助提示词里的续写提示。"
          checked={value.continuePrefill}
          onChange={(v) => set('continuePrefill', v)}
        />
        <SelectField
          label="续写连接符"
          hint="在原消息与续写结果之间补上所选字符。"
          value={value.continuePostfix}
          onChange={(v) => set('continuePostfix', v)}
          options={[
            { value: '', label: '无' },
            { value: ' ', label: '空格' },
            { value: '\n', label: '换行' },
            { value: '\n\n', label: '两个换行' },
          ]}
        />
        <TextAreaField
          label="回复预填充"
          hint="作为最后一条 assistant 消息的开头，引导模型接着写；只有部分接口支持，留空则不使用。"
          value={value.assistantPrefill}
          onChange={(v) => set('assistantPrefill', v)}
        />
        <TextAreaField
          label="代写预填充"
          hint="代写用户回复时使用的开头文字；只有部分接口支持，留空则不使用。"
          value={value.assistantImpersonationPrefill}
          onChange={(v) => set('assistantImpersonationPrefill', v)}
        />
      </Section>
      <Section dense title="角色卡与示例">
        <SwitchField
          label="优先使用角色卡主提示词"
          hint="角色卡含 system_prompt 时优先使用；角色卡可用 {{original}} 引用预设原文。"
          checked={value.preferCharPrompt}
          onChange={(v) => set('preferCharPrompt', v)}
        />
        <SwitchField
          label="优先使用角色卡历史后指令"
          hint="角色卡含 post_history_instructions 时优先使用该指令。"
          checked={value.preferCharInstructions}
          onChange={(v) => set('preferCharInstructions', v)}
        />
        <SelectField
          label="示例对话策略"
          hint="控制角色卡里的示例对话如何占用上下文预算。"
          value={value.exampleBehavior}
          onChange={(v) => set('exampleBehavior', v)}
          options={[
            { value: 'gradual', label: '预算不够时逐步丢弃' },
            { value: 'keep', label: '总是保留' },
            { value: 'disabled', label: '不发送' },
          ]}
        />
      </Section>
    </div>
  )
}
