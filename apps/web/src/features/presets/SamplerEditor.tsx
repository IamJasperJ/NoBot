import type { SamplerSettings } from '@ai-parter/shared'
import { useTools } from '../../api/queries'
import {
  ListField,
  NotImplemented,
  NumberField,
  Section,
  SelectField,
  SwitchField,
  TextAreaField,
  Toggle,
} from '../../components/form'
import { cx } from '../../components/ui'
import { t } from '../../i18n'
import { errorMessage } from '../../stores/toast'
import { isExtraBodyValid } from './presetEditor'

const nonstandard = () => t('非 OpenAI 标准参数，只在不是默认值时发送，OpenRouter、本地模型支持。')
const sampling = (): {
  key: keyof Pick<
    SamplerSettings,
    'temperature' | 'topP' | 'topK' | 'minP' | 'topA' | 'repetitionPenalty' | 'frequencyPenalty' | 'presencePenalty'
  >
  label: string
  min: number
  max: number
  step: number
  hint: string
}[] => [
  {
    key: 'temperature',
    label: t('温度'),
    min: 0,
    max: 2,
    step: 0.01,
    hint: t('越高越有创意，越低越稳定；建议从 1 开始调整。'),
  },
  {
    key: 'topP',
    label: t('核采样（top P）'),
    min: 0,
    max: 1,
    step: 0.01,
    hint: t('只从累计概率达到这个比例的候选中采样，越低选择越集中。'),
  },
  {
    key: 'topK',
    label: t('候选数量（top K）'),
    min: 0,
    max: 500,
    step: 1,
    hint: t('只保留概率最高的 K 个候选，0 表示不限制。{nonstandard}', { nonstandard: nonstandard() }),
  },
  {
    key: 'minP',
    label: t('最低概率（min P）'),
    min: 0,
    max: 1,
    step: 0.01,
    hint: t('过滤相对最高概率过低的候选，0 表示关闭。{nonstandard}', { nonstandard: nonstandard() }),
  },
  {
    key: 'topA',
    label: t('自适应采样（top A）'),
    min: 0,
    max: 1,
    step: 0.01,
    hint: t('根据最高概率动态过滤候选，0 表示关闭。{nonstandard}', { nonstandard: nonstandard() }),
  },
  {
    key: 'repetitionPenalty',
    label: t('重复惩罚'),
    min: 0,
    max: 3,
    step: 0.01,
    hint: t('减少重复内容，1 表示不惩罚。{nonstandard}', { nonstandard: nonstandard() }),
  },
  {
    key: 'frequencyPenalty',
    label: t('频率惩罚'),
    min: -2,
    max: 2,
    step: 0.01,
    hint: t('正值减少经常出现的词，负值鼓励重复使用。'),
  },
  {
    key: 'presencePenalty',
    label: t('存在惩罚'),
    min: -2,
    max: 2,
    step: 0.01,
    hint: t('正值鼓励新话题，负值鼓励使用已出现的词。'),
  },
]

export function SamplerEditor({ value, onChange }: { value: SamplerSettings; onChange: (v: SamplerSettings) => void }) {
  const tools = useTools()
  const set = <K extends keyof SamplerSettings>(key: K, v: SamplerSettings[K]) => onChange({ ...value, [key]: v })
  return (
    <div className="space-y-2">
      <Section dense title={t('上下文')}>
        <NumberField
          label={t('上下文长度')}
          hint={t('上下文长度（token）。超过后最旧的聊天记录会被截掉')}
          value={value.contextSize}
          onChange={(v) => set('contextSize', Math.round(v))}
          min={512}
          max={2000000}
          slider={false}
        />
        <NumberField
          label={t('最大回复长度')}
          hint={t('限制每次回复最多生成多少 token，较长的回复会消耗更多额度。')}
          value={value.maxTokens}
          onChange={(v) => set('maxTokens', Math.round(v))}
          min={1}
          max={200000}
          slider={false}
        />
        <SwitchField
          label={t('流式传输')}
          hint={t('生成时逐字显示回复，关闭后等待完整回复。')}
          checked={value.stream}
          onChange={(v) => set('stream', v)}
        />
        <NumberField
          label={t('每次生成的回复数')}
          hint={t('一次请求生成多个候选回复，暂时不生效。')}
          notImplemented
          value={value.n}
          onChange={(v) => set('n', Math.round(v))}
          min={1}
          max={8}
        />
      </Section>
      <Section dense title={t('采样')}>
        {sampling().map(({ key, ...props }) => (
          <NumberField
            key={key}
            {...props}
            value={value[key]}
            onChange={(v) => set(key, key === 'topK' ? Math.round(v) : v)}
          />
        ))}
        <NumberField
          label={t('随机种子')}
          hint={t('-1 表示随机；固定为同一整数可尝试复现结果，是否生效取决于接口。')}
          value={value.seed}
          onChange={(v) => set('seed', Math.round(v))}
          min={-1}
          max={Number.MAX_SAFE_INTEGER}
          slider={false}
        />
      </Section>
      <Section dense title={t('推理与工具')}>
        <SelectField
          label={t('推理强度')}
          hint={t('控制支持推理的模型投入多少思考；自动表示不发送该参数。')}
          value={value.reasoningEffort}
          onChange={(v) => set('reasoningEffort', v)}
          options={[
            { value: 'auto', label: t('自动（不发送）') },
            { value: 'minimal', label: t('minimal（最少）') },
            { value: 'low', label: t('low（低）') },
            { value: 'medium', label: t('medium（中）') },
            { value: 'high', label: t('high（高）') },
          ]}
        />
        <SwitchField
          label={t('请求思考过程')}
          hint={t('通过 OpenRouter 的 include_reasoning 请求模型返回思考过程，需接口支持。')}
          checked={value.requestReasoning}
          onChange={(v) => set('requestReasoning', v)}
        />
        <SwitchField
          label={t('工具调用')}
          hint={t('允许模型调用工具（function calling），需要模型本身支持。下面可以单独开关每个工具。')}
          checked={value.functionCalling}
          onChange={(v) => set('functionCalling', v)}
        />
        {/* 每个工具单独的开关；总开关关闭时整组变灰 */}
        <div
          className={cx(
            'col-span-full space-y-0.5 pb-1 pl-38',
            !value.functionCalling && 'pointer-events-none opacity-50',
          )}
        >
          {tools.isPending && <p className="text-xs text-zinc-500">{t('工具列表加载中…')}</p>}
          {tools.isError && (
            <p className="text-xs text-red-500">
              {t('获取工具列表失败：{error}', { error: errorMessage(tools.error) })}
            </p>
          )}
          {tools.data?.length === 0 && <p className="text-xs text-zinc-500">{t('暂无可用工具')}</p>}
          {tools.data?.map((tool) => (
            <div key={tool.name} className="flex min-h-7 items-center gap-2.5" title={tool.description}>
              <Toggle
                label={t('启用工具 {name}', { name: tool.name })}
                checked={!value.disabledTools.includes(tool.name)}
                onChange={(on) =>
                  set(
                    'disabledTools',
                    on ? value.disabledTools.filter((n) => n !== tool.name) : [...value.disabledTools, tool.name],
                  )
                }
              />
              <span className="shrink-0 font-mono text-[13px]">{tool.name}</span>
              <span className="shrink-0 text-xs text-zinc-400">
                {tool.source === 'builtin' ? t('内置') : tool.source}
              </span>
              <span className="min-w-0 truncate text-xs text-zinc-500">{tool.description}</span>
            </div>
          ))}
        </div>
        <SwitchField
          label={t('联网搜索')}
          hint={t('使用接口自带的联网搜索，暂时不生效。')}
          notImplemented
          checked={value.webSearch}
          onChange={(v) => set('webSearch', v)}
        />
        <SwitchField
          label={t('发送图片')}
          hint={t('向模型发送附加图片，需要模型支持看图。')}
          checked={value.inlineImages}
          onChange={(v) => set('inlineImages', v)}
        />
        <NumberField
          label={t('图片数量限制')}
          hint={t('从最新消息往前保留的图片总数，0 表示不限；更早的图片用 [图片] 代替。')}
          value={value.imageLimit}
          onChange={(v) => set('imageLimit', Math.round(v))}
          min={0}
          max={50}
          slider={false}
        />
        <NumberField
          label={t('图片最大边长')}
          hint={t('发送前缩小图片，单位像素；不会放大小图。上传存储的最大边为 2048 像素。')}
          value={value.imageMaxSize}
          onChange={(v) => set('imageMaxSize', Math.round(v))}
          min={256}
          max={4096}
          slider={false}
        />
        <SelectField
          label={t('图片细节')}
          hint={t('自动由模型决定；低细节更节省用量，高细节更适合识别小字和细节。')}
          value={value.imageDetail}
          onChange={(v) => set('imageDetail', v)}
          options={[
            { value: 'auto', label: t('自动（auto）') },
            { value: 'low', label: t('低细节（low）') },
            { value: 'high', label: t('高细节（high）') },
          ]}
        />
      </Section>
      <Section dense title={t('高级')}>
        <ListField
          label={t('停止序列')}
          hint={t('模型遇到这些文字就停止生成，最多 4 个；清空表示不设置。')}
          value={value.stop}
          onChange={(v) => set('stop', v.slice(0, 4))}
        />
        <div
          className="flex min-h-9 items-center text-[13px] text-zinc-700 dark:text-zinc-300"
          title={t('需要按模型的分词器把文字转换为 token id，暂不提供编辑器。')}
        >
          {t('词元偏置（Logit Bias）')}
          <NotImplemented />
        </div>
        <TextAreaField
          label={t('额外请求参数')}
          mono
          hint={t('会原样合并进请求体的 JSON 对象，例如 {"provider": {"order": ["DeepSeek"]}}')}
          value={value.extraBody}
          onChange={(v) => set('extraBody', v)}
        />
        {!isExtraBodyValid(value.extraBody) && (
          <p role="alert" className="col-span-full text-[13px] text-red-600">
            {t('请输入合法的 JSON 对象；数组、字符串和 null 都不能作为请求参数。')}
          </p>
        )}
      </Section>
    </div>
  )
}
