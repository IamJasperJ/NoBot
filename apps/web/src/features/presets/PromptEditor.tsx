import {
  BUILTIN_PROMPTS,
  type BuiltinPromptId,
  type GenerationType,
  type PromptBlock,
  promptBlockSchema,
} from '@ai-parter/shared'
import { useRef, useState } from 'react'
import { NumberField, SelectField, TextAreaField, TextField, Toggle } from '../../components/form'
import { ChevronLeftIcon, ChevronRightIcon } from '../../components/icons'
import { Button, IconButton } from '../../components/ui'
import { t } from '../../i18n'
import { builtinPromptNames, generationTypeLabels } from '../../i18n-labels'
import { movePrompt } from './presetEditor'

function builtin(id: string) {
  return Object.hasOwn(BUILTIN_PROMPTS, id) ? BUILTIN_PROMPTS[id as BuiltinPromptId] : undefined
}

const markerSources = (): Partial<Record<BuiltinPromptId, string>> => ({
  wi_before: t('来自世界书中放在角色定义之前的条目。'),
  wi_after: t('来自世界书中放在角色定义之后的条目。'),
  char_description: t('来自角色卡里的角色描述。'),
  char_personality: t('来自角色卡里的性格，使用辅助提示词中的性格格式包装。'),
  scenario: t('来自角色卡里的场景或群聊的场景覆盖，使用场景格式包装。'),
  persona: t('来自当前用户人设的描述。'),
  examples: t('来自角色卡和世界书提供的示例对话。'),
  history: t('来自当前会话的聊天记录，按上下文预算保留最近的消息。'),
})

export function PromptEditor({ value, onChange }: { value: PromptBlock[]; onChange: (v: PromptBlock[]) => void }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const dragged = useRef<string | null>(null)
  const update = (id: string, patch: Partial<PromptBlock>) =>
    onChange(value.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed text-zinc-500">
        {t('从上到下就是发送顺序。『聊天内』条目会按深度插进聊天记录，不受列表顺序影响。')}
      </p>
      {value.length === 0 && <p className="text-sm text-zinc-500">{t('还没有 Prompt 条目，点击下方按钮添加。')}</p>}
      {value.map((block, index) => {
        const built = builtin(block.id)
        return (
          <section key={block.id} className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
            <div className="flex h-11 min-w-[22rem] items-center gap-2 px-2">
              <button
                type="button"
                draggable
                onDragStart={(event) => {
                  dragged.current = block.id
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', block.id)
                }}
                onDragEnd={() => {
                  dragged.current = null
                }}
                className="cursor-grab px-1 text-zinc-400"
                title={t('拖动排序')}
                aria-label={t('拖动{name}排序', { name: block.name })}
              >
                ⠿
              </button>
              <Toggle
                label={t('启用{name}', { name: block.name })}
                checked={block.enabled}
                onChange={(enabled) => update(block.id, { enabled })}
              />
              <button
                type="button"
                className="min-w-[8em] flex-1 truncate text-left text-sm"
                title={block.name || t('未命名条目')}
                aria-expanded={expanded === block.id}
                onClick={() => setExpanded(expanded === block.id ? null : block.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  if (dragged.current) onChange(movePrompt(value, dragged.current, index))
                  dragged.current = null
                }}
              >
                <span className="font-medium">{block.name || t('未命名条目')}</span>
              </button>
              <span
                className="shrink-0 rounded bg-zinc-100 px-1 text-xs text-zinc-500 dark:bg-zinc-800"
                title={t('{role} · {position} · {triggers}{sourceNotice}', {
                  role: block.role,
                  position:
                    block.position === 'relative' ? t('相对') : t('聊天内 · 深度 {depth}', { depth: block.depth }),
                  triggers: block.triggers.map((t) => generationTypeLabels()[t]).join('、'),
                  sourceNotice: built?.marker ? t(' · 内容来自角色卡 / 世界书 / 聊天记录') : '',
                })}
              >
                {block.role}
              </span>
              <div className="flex shrink-0">
                <IconButton
                  className="shrink-0"
                  disabled={index === 0}
                  onClick={() => onChange(movePrompt(value, block.id, index - 1))}
                  label={t('上移')}
                >
                  <ChevronLeftIcon className="rotate-90" />
                </IconButton>
                <IconButton
                  className="shrink-0"
                  disabled={index === value.length - 1}
                  onClick={() => onChange(movePrompt(value, block.id, index + 1))}
                  label={t('下移')}
                >
                  <ChevronRightIcon className="rotate-90" />
                </IconButton>
              </div>
            </div>
            {expanded === block.id && (
              <div className="space-y-4 border-t border-zinc-200 p-4 dark:border-zinc-800">
                <TextField
                  label={t('条目名称')}
                  hint={t('用于辨认这段提示词，不会作为提示词正文发送。')}
                  value={block.name}
                  onChange={(name) => update(block.id, { name })}
                />
                <SelectField
                  label={t('消息角色')}
                  hint={t('指定模型把此条目视为系统指令、用户消息还是助手消息。')}
                  value={block.role}
                  onChange={(role) => update(block.id, { role })}
                  options={[
                    { value: 'system', label: t('system（系统）') },
                    { value: 'user', label: t('user（用户）') },
                    { value: 'assistant', label: t('assistant（助手）') },
                  ]}
                />
                <SelectField
                  label={t('插入位置')}
                  hint={t('相对位置按列表发送；聊天内位置按深度插入历史消息。')}
                  value={block.position}
                  onChange={(position) => update(block.id, { position })}
                  options={[
                    { value: 'relative', label: t('相对（按列表顺序）') },
                    { value: 'in_chat', label: t('聊天内（按深度插入）') },
                  ]}
                />
                {block.position === 'in_chat' && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <NumberField
                      label={t('深度')}
                      hint={t('0 在最后一条之后，1 在最后一条之前，以此类推。')}
                      value={block.depth}
                      min={0}
                      max={9999}
                      slider={false}
                      onChange={(v) => update(block.id, { depth: Math.round(v) })}
                    />
                    <NumberField
                      label={t('同深度顺序')}
                      hint={t('同一深度内数字较小的条目在前。')}
                      value={block.order}
                      min={Number.MIN_SAFE_INTEGER}
                      max={Number.MAX_SAFE_INTEGER}
                      slider={false}
                      onChange={(v) => update(block.id, { order: Math.round(v) })}
                    />
                  </div>
                )}
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">{t('触发类型')}</legend>
                  <p className="text-xs text-zinc-500">{t('都不选表示所有类型都发送。')}</p>
                  <div className="flex flex-wrap gap-3">
                    {(Object.entries(generationTypeLabels()) as [GenerationType, string][]).map(([type, label]) => (
                      <label key={type} className="flex items-center gap-1 text-sm">
                        <input
                          type="checkbox"
                          className="accent-violet-600"
                          checked={block.triggers.includes(type)}
                          onChange={(event) =>
                            update(block.id, {
                              triggers: event.target.checked
                                ? [...block.triggers, type]
                                : block.triggers.filter((t) => t !== type),
                            })
                          }
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
                {built?.marker ? (
                  <p className="rounded-lg bg-zinc-100 p-3 text-sm text-zinc-500 dark:bg-zinc-900">
                    {t('「{name}」：{source}内容由系统自动填入，不能在此编辑正文。', {
                      name: builtinPromptNames()[block.id as BuiltinPromptId],
                      source: markerSources()[block.id as BuiltinPromptId] ?? '',
                    })}
                  </p>
                ) : (
                  <TextAreaField
                    label={t('提示词正文')}
                    hint={t('发送给模型的文本；支持 {{char}}、{{user}} 等宏。')}
                    rows={8}
                    value={block.content}
                    onChange={(content) => update(block.id, { content })}
                  />
                )}
                {!built && (
                  <Button
                    variant="danger"
                    onClick={() => {
                      if (confirm(t('删除自定义条目「{name}」？保存预设后生效。', { name: block.name }))) {
                        onChange(value.filter((p) => p.id !== block.id))
                        setExpanded(null)
                      }
                    }}
                  >
                    {t('删除条目')}
                  </Button>
                )}
              </div>
            )}
          </section>
        )
      })}
      <Button
        onClick={() => {
          const block = promptBlockSchema.parse({ id: crypto.randomUUID(), name: t('自定义条目') })
          onChange([...value, block])
          setExpanded(block.id)
        }}
      >
        {t('添加自定义条目')}
      </Button>
    </div>
  )
}
