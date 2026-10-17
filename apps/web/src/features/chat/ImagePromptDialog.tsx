import * as React from 'react'
import { createPortal } from 'react-dom'
import { cx, inputClass } from '../../components/ui'
import { t } from '../../i18n'

interface ImagePromptPreview {
  prompt: string
  negative: string
  width?: number
  height?: number
  source?: string
  model?: string
  workflow?: string
}

const primaryButton =
  'inline-flex h-9 items-center justify-center rounded-lg bg-violet-600 px-4 text-sm font-medium text-white shadow-xs hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50'
const secondaryButton =
  'inline-flex h-9 items-center justify-center rounded-lg border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-700 shadow-xs hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800'

/**
 * 生成前编辑提示词的对话框。
 * 用 portal 渲染到 document.body：它常被放在输入框里打开，而有背景时输入框带毛玻璃（backdrop-filter），
 * 这会让里面 fixed 定位的元素改为相对输入框定位，对话框就会被挤到屏幕底部、按钮看不到
 */
export function ImagePromptDialog({
  review,
  react = React,
  title = t('生成前编辑提示词'),
}: {
  react?: typeof React
  /** 对话框标题；改已有图片的提示词时用「修改提示词，再生成一张」 */
  title?: string
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
  const { source, model, width, height, workflow } = review.preview
  const summary = source
    ? [
        t('后端：{backend}', { backend: source === 'comfy' ? 'ComfyUI' : t('OpenAI 兼容接口') }),
        t('模型：{model}', { model: model?.trim() || (source === 'comfy' ? t('工作流默认') : t('未设置')) }),
        width && height ? t('尺寸：{width}×{height}', { width, height }) : '',
        source === 'comfy' && workflow ? t('工作流：{workflow}', { workflow }) : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : ''
  const dialog = h(
    'div',
    {
      className: 'fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4',
      onClick: () => review.resolve(null),
    },
    h(
      'div',
      {
        role: 'dialog',
        'aria-modal': true,
        'aria-label': title,
        className:
          'flex max-h-[calc(100dvh-32px)] w-full max-w-2xl flex-col gap-4 overflow-y-auto rounded-2xl bg-white p-5 text-zinc-900 shadow-xl dark:bg-zinc-900 dark:text-zinc-100',
        onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
      },
      h(
        'div',
        { className: 'space-y-1' },
        h('h2', { className: 'font-semibold' }, title),
        summary && h('p', { className: 'text-xs text-zinc-500' }, summary),
      ),
      h(
        'label',
        { className: 'block space-y-1.5' },
        h('span', { className: 'block text-[13px] font-medium' }, t('正向提示词')),
        h('textarea', {
          'aria-label': t('正向提示词'),
          rows: 6,
          className: cx(inputClass, 'resize-y font-mono text-xs leading-relaxed'),
          value: prompt,
          onChange: (event: { target: { value: string } }) => setPrompt(event.target.value),
        }),
      ),
      h(
        'label',
        { className: 'block space-y-1.5' },
        h('span', { className: 'block text-[13px] font-medium' }, t('负面提示词')),
        h('textarea', {
          'aria-label': t('负面提示词'),
          rows: 3,
          className: cx(inputClass, 'resize-y font-mono text-xs leading-relaxed'),
          value: negative,
          onChange: (event: { target: { value: string } }) => setNegative(event.target.value),
        }),
      ),
      h(
        'div',
        { className: 'flex justify-end gap-2' },
        h('button', { type: 'button', className: secondaryButton, onClick: () => review.resolve(null) }, t('取消')),
        h(
          'button',
          {
            type: 'button',
            className: primaryButton,
            disabled: !prompt.trim(),
            onClick: () => review.resolve({ prompt, negative }),
          },
          t('开始生成'),
        ),
      ),
    ),
  )
  // 服务端渲染（测试）时没有 document，直接返回内容
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
}
