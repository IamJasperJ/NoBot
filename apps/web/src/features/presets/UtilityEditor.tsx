import type { UtilityPrompts } from '@ai-parter/shared'
import { DenseGrid, TextAreaField } from '../../components/form'

const fields: { key: keyof UtilityPrompts; label: string; hint: string }[] = [
  {
    key: 'worldInfoFormat',
    label: '世界书格式',
    hint: '包装每条世界书内容，{0} 会替换为条目正文；留空则不输出条目正文。',
  },
  {
    key: 'scenarioFormat',
    label: '场景格式',
    hint: '包装角色场景，{{scenario}} 会替换为场景正文；留空则不发送此格式内容。',
  },
  {
    key: 'personalityFormat',
    label: '性格格式',
    hint: '包装角色性格，{{personality}} 会替换为性格正文；留空则不发送此格式内容。',
  },
  {
    key: 'groupNudge',
    label: '群聊角色提醒',
    hint: '群聊时放在最后，要求指定角色回复；{{char}} 是当前角色。留空则不发送。',
  },
  { key: 'newChat', label: '新对话标记', hint: '放在聊天记录之前，标记背景结束、对话开始。留空则不发送。' },
  { key: 'newGroupChat', label: '新群聊标记', hint: '标记群聊开始，{{group}} 是群成员名单。留空则不发送。' },
  {
    key: 'newExampleChat',
    label: '示例对话标记',
    hint: '标记示例对话开始，帮助模型区分示例与实际聊天。留空则不发送。',
  },
  {
    key: 'continueNudge',
    label: '续写提示',
    hint: '续写时放在最后；{{lastChatMessage}} 是最后一条消息。启用续写预填充时改用预填充，留空则不发送此提示。',
  },
  {
    key: 'impersonation',
    label: '代写提示',
    hint: '要求模型替用户写下一条回复；{{user}} 是用户，{{char}} 是角色；留空则不发送此提示。',
  },
  { key: 'sendIfEmpty', label: '空消息替代文字', hint: '输入框为空时发送这段文字；留空则发送空消息。' },
]

export function UtilityEditor({ value, onChange }: { value: UtilityPrompts; onChange: (v: UtilityPrompts) => void }) {
  return (
    <DenseGrid>
      <p className="col-span-full pb-1 text-xs leading-relaxed text-zinc-500">
        {
          '格式占位符：{0}（世界书正文）、{{scenario}}（场景）、{{personality}}（性格）。通用宏：{{char}}（角色）、{{user}}（用户）、{{group}}（群成员）、{{lastChatMessage}}（最后一条消息）。'
        }
      </p>
      {fields.map(({ key, label, hint }) => (
        <TextAreaField
          key={key}
          label={label}
          hint={hint}
          value={value[key]}
          onChange={(v) => onChange({ ...value, [key]: v })}
        />
      ))}
    </DenseGrid>
  )
}
