import { expect, test } from 'bun:test'
import { cleanPrompt, prefixPrompt, rawPrompt, replaceTemplate } from './modes'
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
