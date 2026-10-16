import * as React from 'react'

interface ImagePromptPreview {
  prompt: string
  negative: string
  width?: number
  height?: number
  source?: string
  model?: string
  workflow?: string
}
const buttonClass = 'rounded px-3 py-1.5 text-left text-sm hover:bg-zinc-500/10 disabled:opacity-50'

export function ImagePromptDialog({
  review,
  react = React,
}: {
  react?: typeof React
  review: { preview: ImagePromptPreview; resolve: (value: { prompt: string; negative: string } | null) => void }
}) {
  const R = react
  const h = R.createElement
  const [prompt, setPrompt] = R.useState(review.preview.prompt)
  const [negative, setNegative] = R.useState(review.preview.negative)
  R.useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') review.resolve(null)
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [review])
  return h(
    'div',
    {
      className: 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4',
      onClick: () => review.resolve(null),
    },
    h(
      'div',
      {
        role: 'dialog',
        'aria-modal': true,
        'aria-label': '生成前编辑提示词',
        className: 'flex w-full max-w-2xl flex-col gap-3 rounded-xl bg-white p-5 dark:bg-zinc-900',
        onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
      },
      h('strong', null, '生成前编辑提示词'),
      h(
        'p',
        { className: 'text-sm text-zinc-500' },
        review.preview.source &&
          `后端：${review.preview.source === 'comfy' ? 'ComfyUI' : 'OpenAI 兼容接口'} · 模型：${review.preview.model} · 尺寸：${review.preview.width}×${review.preview.height} · 工作流：${review.preview.workflow}`,
      ),
      h(
        'label',
        null,
        '正向提示词',
        h('textarea', {
          'aria-label': '正向提示词',
          rows: 6,
          className: 'mt-1 w-full rounded border bg-transparent p-2',
          value: prompt,
          onChange: (event: { target: { value: string } }) => setPrompt(event.target.value),
        }),
      ),
      h(
        'label',
        null,
        '负面提示词',
        h('textarea', {
          'aria-label': '负面提示词',
          rows: 3,
          className: 'mt-1 w-full rounded border bg-transparent p-2',
          value: negative,
          onChange: (event: { target: { value: string } }) => setNegative(event.target.value),
        }),
      ),
      h(
        'div',
        { className: 'flex justify-end gap-2' },
        h('button', { type: 'button', className: buttonClass, onClick: () => review.resolve(null) }, '取消'),
        h(
          'button',
          {
            type: 'button',
            className: buttonClass,
            disabled: !prompt.trim(),
            onClick: () => review.resolve({ prompt, negative }),
          },
          '开始生成',
        ),
      ),
    ),
  )
}
