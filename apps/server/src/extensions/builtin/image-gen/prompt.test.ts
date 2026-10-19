import { expect, test } from 'bun:test'
import { composePrompt, resolvePromptStyle } from './composition'
import {
  cleanPrompt,
  prefixPrompt,
  promptInstruction,
  rawPrompt,
  replaceTemplate,
  templateEndings,
  templates,
} from './modes'
import { generatedPrompt, imageInstruction, imageSourceText } from './prompting'
import { parseSettings } from './settings'
import { buildWorkflow } from './workflow'

test('提示词清理移除思考、围栏、引号、前缀，并规范逗号和长度', () => {
  expect(cleanPrompt('<think>秘密\n思考</think>```text\nPrompt: "1girl, , blue eyes"\nforest\n```')).toBe(
    '1girl, blue eyes, forest',
  )
  expect(cleanPrompt('<think>未结束')).toBe('')
  expect(cleanPrompt('a'.repeat(2000))).toHaveLength(1500)
  expect(prefixPrompt('', 'Prompt: cat')).toBe('cat')
  expect(prefixPrompt('best quality', 'cat')).toBe('best quality, cat')
  expect(rawPrompt(' *走进森林*\n   看向天空 ')).toBe('走进森林 看向天空')
  expect(rawPrompt('字'.repeat(1200))).toHaveLength(1000)
})
test('模板替换保留用户输入中的占位符和美元符号，不递归替换', () => {
  expect(
    replaceTemplate('{{char}} {{user}} {{input}} {{char}}', { char: '莱恩', user: '旅人', input: '$& {{char}}' }),
  ).toBe('莱恩 旅人 $& {{char}} 莱恩')
  expect(replaceTemplate('{0} {{input}}', { char: 'Kana', user: 'User', input: '$& {0} {{char}}' })).toBe(
    '$& {0} {{char}} $& {0} {{char}}',
  )
})

test('酒馆自定义模板没有输入宏时也固定待画消息，有宏时不重复追加', () => {
  const values = { char: 'Kana', user: 'User', input: 'A woman beside the window.' }
  expect(imageInstruction('last', 'Choose one still image.', 'tags', values)).toBe(
    'Choose one still image.\n\nIllustrate this specific message, even if newer messages have arrived:\nA woman beside the window.',
  )
  for (const macro of ['{{input}}', '{0}']) {
    expect(imageInstruction('free', `Describe ${macro}.`, 'tags', values)).toBe('Describe A woman beside the window..')
  }
  expect(imageInstruction('free', 'Describe a picture.', 'tags', values)).toContain(values.input)
})

test('图片提炼保留剧情和角色名，排除舞台、变量和选项协议', () => {
  const text = imageSourceText(
    '<scene place="room" /><show who="Kana" />She stands by a window.\n<say who="Kana">Hello.</say>\n<state>score = 1</state><choices>\n- Leave\n</choices>',
    ['Kana'],
  )
  expect(text).toContain('She stands by a window.')
  expect(text).toContain('Hello.')
  expect(text).not.toMatch(/<|score|Leave/)
})

test('提炼回复不能把舞台续写混入绘图词，也不能把只有剧情的回复当成功', () => {
  expect(generatedPrompt('1girl, blue hair\n\n<scene place="room" />新的剧情<say who="Kana">对白</say>')).toBe(
    '1girl, blue hair',
  )
  expect(generatedPrompt('<show who="Kana" />中文剧情')).toBe('')
  expect(generatedPrompt('Kana sends a picture that contains: 1girl, blue hair')).toBe('1girl, blue hair')
  expect(generatedPrompt('1girl, <lora:style:0.8>, café')).toBe('1girl, <lora:style:0.8>, cafe')
  expect(generatedPrompt('{"描述":"中文"}', true)).toBe('{"描述":"中文"}')
})
test('ComfyUI 占位符：字符串转义、数字类型、固定及随机种子', () => {
  const settings = parseSettings({
    comfyWorkflowName: 'test',
    comfyWorkflows: [
      {
        name: 'test',
        json: '{"text":"%prompt%","negative":"%negative_prompt%","model":"%model%","sampler":"%sampler%","scheduler":"%scheduler%","w":"%width%","h":"%height%","seed":"%seed%","steps":"%steps%","cfg":"%scale%"}',
      },
    ],
    comfyCheckpoint: '模型".safetensors',
  })
  const prompt = 'cat "quoted" \\ line\n%model%'
  const result = buildWorkflow(settings, prompt, 832, 1216, () => 0.5)
  expect(result).toMatchObject({
    text: prompt,
    model: '模型".safetensors',
    w: 832,
    h: 1216,
    seed: 2 ** 47,
    steps: 25,
    cfg: 7,
    sampler: 'euler_ancestral',
    scheduler: 'normal',
  })
  expect(JSON.parse(JSON.stringify(result)).text).toBe(prompt)
  expect(buildWorkflow({ ...settings, seed: 42 }, 'cat', 1, 2).seed).toBe(42)
  expect(() => buildWorkflow({ ...settings, comfyWorkflows: [{ name: 'test', json: '{' }] }, '', 1, 1)).toThrow(
    '不是合法的 JSON',
  )
  expect(() => buildWorkflow({ ...settings, comfyWorkflows: [{ name: 'test', json: '[]' }] }, '', 1, 1)).toThrow(
    'API 格式',
  )
  const normal = buildWorkflow(parseSettings({}), 'cat', 64, 64, () => 0)
  expect(normal['9']).toMatchObject({ class_type: 'SaveImage' })
})

test('promptStyle 自动按后端与工作流判断，显式选择优先', () => {
  // 默认是短标签；auto 才按后端和工作流判断
  expect(resolvePromptStyle(parseSettings({ source: 'openai' }))).toBe('tags')
  expect(resolvePromptStyle(parseSettings({ source: 'openai', promptStyle: 'auto' }))).toBe('natural')
  expect(resolvePromptStyle(parseSettings({ source: 'comfy', promptStyle: 'auto' }))).toBe('tags')
  for (const loader of ['UNETLoader', 'UnetLoaderGGUF', 'DualCLIPLoader', 'CLIPLoaderGGUF', 'lumina2', 'flux']) {
    const settings = parseSettings({
      source: 'comfy',
      promptStyle: 'auto',
      comfyWorkflowName: 'test',
      comfyWorkflows: [{ name: 'test', json: JSON.stringify({ '1': { class_type: loader } }) }],
    })
    expect(resolvePromptStyle(settings)).toBe('natural')
    expect(
      resolvePromptStyle({ ...settings, comfyWorkflows: [{ name: 'test', json: `${loader} CheckpointLoaderSimple` }] }),
    ).toBe('tags')
    expect(resolvePromptStyle({ ...settings, promptStyle: 'tags' })).toBe('tags')
  }
})

test('格式结尾只追加到内置默认模板，自定义模板保持原样', () => {
  for (const style of ['tags', 'natural'] as const) {
    for (const mode of ['free', 'background', 'character'] as const) {
      expect(promptInstruction(mode, '', style)).toBe(`${templates[mode]}\n${templateEndings[style]}`)
      expect(promptInstruction(mode, templates[mode], style)).toBe(`${templates[mode]}\n${templateEndings[style]}`)
      expect(promptInstruction(mode, 'Custom {{input}}', style)).toBe('Custom {{input}}')
    }
  }
})

test('正负提示词拼接去掉各段首尾空白和逗号，也支持插入占位符', () => {
  const settings = parseSettings({
    styles: [
      { name: 'test', promptPrefix: ' , highres, ', promptSuffix: ', cinematic, ', negativePrompt: ', blurry, ' },
    ],
    activeStyle: 'test',
  })
  expect(
    composePrompt(settings, 'free', ', bright, ', { positive: ' , blue hair, ', negative: ', lowres, ' }, ', text, '),
  ).toEqual({
    prompt: 'highres, blue hair, bright, cinematic',
    negative: 'blurry, lowres, text',
    rawPrompt: 'bright',
  })
  settings.styles[0]!.promptPrefix = ', highres, {prompt}, '
  expect(composePrompt(settings, 'free', 'bright', {}).prompt).toBe('highres, bright, cinematic')
})

test('清理提示词时去掉舞台指令，保留 lora 写法', async () => {
  const { cleanPrompt } = await import('./modes')
  expect(
    cleanPrompt('<scene bg="公会大厅" /> 1girl, <lora:style:0.8>, tavern\n<state>\naffection += 3\n</state>'),
  ).toBe('1girl, <lora:style:0.8>, tavern')
})
