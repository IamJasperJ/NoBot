import { expect, test } from 'bun:test'
import { openaiBody } from './backends/openai'
import { characterPrompt, composePrompt, dimensions, matchInteractive } from './composition'
import { cleanPrompt, type Mode, prefixPrompt } from './modes'
import { imageModelOptions, isImageModel, openaiSize, orientResolution, resolutionOptions } from './options'
import { parseSettings } from './settings'
import { avatarWorkflow, buildWorkflow } from './workflow'

test('图片模型识别不区分大小写，图片优先并可关闭筛选', () => {
  for (const name of [
    'GPT-IMAGE-1',
    'DALL-E-3',
    'flux-dev',
    'stable-diffusion',
    'kolors',
    'Seedream',
    'imagen',
    'midjourney',
    'cogview',
    'wanx',
    'qwen-image',
    'hidream',
    'recraft',
    'ideogram',
    'sdxl',
  ])
    expect(isImageModel(name)).toBe(true)
  expect(isImageModel('gpt-4.1')).toBe(false)
  expect(imageModelOptions(['gpt-4.1', 'flux-dev', 'flux-dev'])).toEqual([
    { value: 'flux-dev', label: 'flux-dev（图片）' },
    { value: 'gpt-4.1', label: 'gpt-4.1' },
  ])
  expect(imageModelOptions(['gpt-4.1', 'flux-dev'])).toHaveLength(2)
})
test('30 个预设，基准对调、贴合、无方向继承、类型尺寸覆盖', () => {
  expect(resolutionOptions).toHaveLength(30)
  expect(orientResolution(1216, 832, 'portrait', true)).toEqual({ width: 832, height: 1216 })
  expect(orientResolution(700, 1100, 'landscape', false)).toEqual({ width: 1100, height: 700 })
  const settings = parseSettings({ resolution: 'custom', width: 1300, height: 800 })
  expect(dimensions(settings, undefined)).toEqual({ width: 1300, height: 800 })
  expect(dimensions(settings, false)).toEqual({ width: 768, height: 1344 })
  expect(
    dimensions(
      parseSettings({ modeOverrides: [{ mode: 'face', enabled: true, width: 400, height: 500 }] }),
      false,
      'face',
    ),
  ).toEqual({ width: 400, height: 500 })
})
test('OpenAI 模型尺寸和质量规则', () => {
  expect(openaiBody(parseSettings({ openaiQuality: 'high' }), 'cat', 832, 1216)).toMatchObject({
    quality: 'high',
    size: '1024x1536',
  })
  expect(openaiBody(parseSettings({ openaiModel: 'flux-dev' }), 'cat', 832, 1216)).not.toHaveProperty('quality')
  expect(openaiSize('gpt-image-1', 832, 1216)).toBe('1024x1536')
  expect(openaiSize('gpt-image-2', 1600, 900)).toBe('1536x1024')
  expect(openaiSize('gpt-image-1', 500, 500)).toBe('1024x1024')
  expect(openaiSize('dall-e-3', 600, 900)).toBe('1024x1792')
  expect(openaiSize('dall-e-3', 900, 600)).toBe('1792x1024')
  expect(openaiSize('dall-e-2', 256, 512)).toBe('512x512')
  expect(openaiSize('dall-e-2', 512, 600)).toBe('1024x1024')
  expect(openaiSize('flux-dev', 832, 1216)).toBe('832x1216')
})
test('固定组合顺序、{prompt} 插入、群聊与自由模式角色规则、最少处理', () => {
  const settings = parseSettings({
    styles: [
      {
        name: '默认',
        promptPrefix: 'style {prompt} lighting',
        promptSuffix: 'suffix',
        negativePrompt: 'style negative',
      },
    ],
  })
  expect(
    composePrompt(settings, 'face', 'Prompt: "cat"', { positive: '<lora:a:0.8>', negative: 'char negative' }, 'once'),
  ).toEqual({
    prompt: 'style <lora:a:0.8>, cat lighting, suffix',
    negative: 'style negative, char negative, once',
    rawPrompt: 'cat',
  })
  settings.modeOverrides = [
    {
      mode: 'face',
      enabled: true,
      promptPrefix: 'override',
      promptSuffix: 'end',
      negativePrompt: 'override negative',
      width: 0,
      height: 0,
    },
  ]
  expect(composePrompt(settings, 'face', 'cat', { positive: 'character', negative: 'bad' }, 'once')).toMatchObject({
    prompt: 'override, character, cat, end',
    negative: 'override negative, bad, once',
  })
  const extensions = { sd_character_prompt: { positive: 'blue hair', negative: 'red hair' } }
  expect(characterPrompt('face', extensions, true)).toEqual(extensions.sd_character_prompt)
  for (const mode of ['scene', 'tool', 'last']) expect(characterPrompt(mode, extensions, true)).toEqual({})
  for (const mode of ['user', 'background', 'free']) expect(characterPrompt(mode, extensions, false)).toEqual({})
  expect(prefixPrompt('before {prompt} after', 'cat')).toBe('before cat after')
  expect(cleanPrompt(' Prompt: {"a":  "b"}\n ', true)).toBe('Prompt: {"a": "b"}')
})
test('中英文交互请求识别，陈述和无关命令不触发', () => {
  const examples: [string, Mode, string?][] = [
    ['给我发一张图片：你', 'character'],
    ['来张自拍', 'face'],
    ['画一张头像', 'face'],
    ['生成一张照片：我自己', 'user'],
    ['发张图，场景', 'scene'],
    ['给我一张图片：上一条', 'last'],
    ['来张图：环境', 'background'],
    ['画一张图：海边的猫', 'free', '海边的猫'],
    ['send a picture of yourself', 'character'],
    ['generate an image of me', 'user'],
    ['draw a picture of a cat', 'free', 'cat'],
    ['show a photo of your face', 'face'],
    ['make a photo of background', 'background'],
    ['render an image of whole story', 'scene'],
    ['paint a picture of last message', 'last'],
  ]
  for (const [input, mode, subject] of examples)
    expect(matchInteractive(input), input).toEqual(subject ? { mode, input: subject } : { mode })
  for (const text of [
    '这张图片真好看',
    '我喜欢照片',
    '不要把消息发给他',
    'The picture is beautiful',
    'create a new chat',
  ])
    expect(matchInteractive(text), text).toBeNull()
})
test('新占位符、数字与头像、宏展开结果、默认头像工作流、替换不递归', () => {
  const settings = parseSettings({
    comfyWorkflowName: 'test',
    comfyWorkflows: [
      {
        name: 'test',
        json: JSON.stringify({
          vae: '%vae%',
          denoise: '%denoise%',
          skip: '%clip_skip%',
          char: '%char_avatar%',
          user: '%user_avatar%',
          custom: '%extra%',
          prompt: '%prompt%',
        }),
      },
    ],
    comfyVae: 'ae',
    comfyDenoise: 0.6,
    comfyClipSkip: -2,
    charAvatar: 'abc',
    userAvatar: 'def',
    comfyCustomPlaceholders: [{ find: 'extra', replace: 'hero %prompt%' }],
  })
  expect(buildWorkflow(settings, 'cat %vae%', 64, 64)).toMatchObject({
    vae: 'ae',
    denoise: 0.6,
    skip: -2,
    char: 'abc',
    user: 'def',
    custom: 'hero %prompt%',
    prompt: 'cat %vae%',
  })
  expect(avatarWorkflow).toContain('ETN_LoadImageBase64')
  expect(avatarWorkflow).toContain('%denoise%')
})

test('工作流 JSON 错误显示具体行列，包含引号与嵌套语法错误', async () => {
  const { workflowValidationError } = await import('./workflow-validation')
  expect(workflowValidationError('{\n  "node": ,\n}')).toContain('第 2 行，第 11 列')
  expect(workflowValidationError('{"a":[1,]}')).toContain('第 1 行，第 9 列')
  expect(workflowValidationError('{"a":"broken}')).toContain('第 1 行，第 14 列')
  expect(workflowValidationError('{}')).toBe('')
  expect(workflowValidationError('[]')).toContain('API 格式')
})
