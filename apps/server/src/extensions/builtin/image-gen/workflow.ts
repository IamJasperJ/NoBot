import { t } from '../../../i18n'
import type { Settings } from './settings'
import { workflowValidationError } from './workflow-validation'

export const defaultWorkflow = JSON.stringify({
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '%model%' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['1', 1] } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: '%negative_prompt%', clip: ['1', 1] } },
  '4': { class_type: 'EmptyLatentImage', inputs: { width: '%width%', height: '%height%', batch_size: 1 } },
  '5': {
    class_type: 'KSampler',
    inputs: {
      model: ['1', 0],
      positive: ['2', 0],
      negative: ['3', 0],
      latent_image: ['4', 0],
      seed: '%seed%',
      steps: '%steps%',
      cfg: '%scale%',
      sampler_name: '%sampler%',
      scheduler: '%scheduler%',
      denoise: 1,
    },
  },
  '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
  '9': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'AI-Parter' } },
})

export const avatarWorkflow = JSON.stringify({
  ...JSON.parse(defaultWorkflow),
  '4': { class_type: 'VAEEncode', inputs: { pixels: ['12', 0], vae: ['1', 2] } },
  '11': { class_type: 'ETN_LoadImageBase64', inputs: { image: '%char_avatar%' } },
  '12': {
    class_type: 'ImageScale',
    inputs: { image: ['11', 0], upscale_method: 'lanczos', width: '%width%', height: '%height%', crop: 'center' },
  },
  '5': { class_type: 'KSampler', inputs: { ...JSON.parse(defaultWorkflow)['5'].inputs, denoise: '%denoise%' } },
})
export const placeholders = [
  'prompt',
  'negative_prompt',
  'model',
  'vae',
  'sampler',
  'scheduler',
  'steps',
  'scale',
  'denoise',
  'clip_skip',
  'width',
  'height',
  'user_avatar',
  'char_avatar',
  'seed',
]
export function workflowSource(settings: Settings): string {
  if (!settings.comfyWorkflowName) return defaultWorkflow
  if (settings.comfyWorkflowName === 'avatar') return avatarWorkflow
  const workflow = settings.comfyWorkflows.find((item) => item.name === settings.comfyWorkflowName)
  if (!workflow) throw new Error(t('找不到名为 {name} 的工作流', { name: settings.comfyWorkflowName }))
  return workflow.json
}
/** 先解析再逐项替换，确保提示词中的引号和占位符不被二次解释。 */
export function buildWorkflow(
  settings: Settings,
  prompt: string,
  width: number,
  height: number,
  random = Math.random,
): Record<string, unknown> {
  const strings: Record<string, string> = {
    prompt,
    negative_prompt: typeof settings.negativePrompt === 'string' ? settings.negativePrompt : '',
    model: settings.comfyCheckpoint,
    sampler: settings.comfySampler,
    scheduler: settings.comfyScheduler,
    vae: settings.comfyVae,
    char_avatar: typeof settings.charAvatar === 'string' ? settings.charAvatar : '',
    user_avatar: typeof settings.userAvatar === 'string' ? settings.userAvatar : '',
  }
  for (const item of settings.comfyCustomPlaceholders) {
    const key = item.find.replace(/^%|%$/g, '')
    if (key && !placeholders.includes(key)) strings[key] = item.replace
  }
  const numbers: Record<string, number> = {
    width,
    height,
    seed: settings.seed === -1 ? Math.floor(random() * 2 ** 48) : settings.seed,
    steps: settings.comfySteps,
    scale: settings.comfyCfg,
    denoise: settings.comfyDenoise,
    clip_skip: settings.comfyClipSkip,
  }
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const numeric = value.match(/^%([^%]+)%$/)?.[1]
      if (numeric && numeric in numbers) return numbers[numeric]
      return value.replace(
        /%([^%]+)%/g,
        (original, key: string) => strings[key] ?? (key in numbers ? String(numbers[key]) : original),
      )
    }
    if (Array.isArray(value)) return value.map(replace)
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
    return value
  }
  const source = workflowSource(settings)
  const error = workflowValidationError(source)
  if (error) throw new Error(error)
  const workflow: unknown = JSON.parse(source)
  return replace(workflow) as Record<string, unknown>
}
