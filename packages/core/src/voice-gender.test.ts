import { expect, test } from 'bun:test'
import { guessVoiceGender } from './voice-gender'

test('声音性别：固定表、供应商字段、female 优先和中文、未知', () => {
  for (const voice of ['alloy', 'sage']) expect(guessVoiceGender('openai', voice)).toBe('neutral')
  for (const voice of ['ash', 'ballad', 'echo', 'fable', 'onyx', 'verse'])
    expect(guessVoiceGender('openai', voice)).toBe('male')
  for (const voice of ['coral', 'nova', 'shimmer']) expect(guessVoiceGender('openai', voice)).toBe('female')
  expect(guessVoiceGender('openai', 'custom')).toBeUndefined()
  expect(guessVoiceGender('edge', 'Xiaoxiao', 'Female')).toBe('female')
  expect(guessVoiceGender('edge', 'Yunxi', 'Male')).toBe('male')
  expect(guessVoiceGender('minimax', 'Chinese_female')).toBe('female')
  expect(guessVoiceGender('volcengine', 'zh_male_xxx')).toBe('male')
  expect(guessVoiceGender('fish', '少女')).toBe('female')
  expect(guessVoiceGender('cosyvoice', '男声')).toBe('male')
  for (const word of ['girl', 'woman']) expect(guessVoiceGender('browser', word)).toBe('female')
  for (const word of ['boy', 'man']) expect(guessVoiceGender('gptsovits', word)).toBe('male')
  expect(guessVoiceGender('fish', 'human')).toBeUndefined()
  expect(guessVoiceGender('fish', 'unknown')).toBeUndefined()
})

test('CosyVoice 游戏音色的类型词与默认音色', () => {
  for (const name of ['原神_少女_刻晴', '原神_御姐_丽莎', '原神_萝莉_可莉'])
    expect(guessVoiceGender('cosyvoice', name)).toBe('female')
  for (const name of ['原神_少年_温迪', '原神_男声_钟离', '原神_KP男声_钟离'])
    expect(guessVoiceGender('cosyvoice', name)).toBe('male')
  for (const word of ['女', '姐', '萝莉', '少女', '御姐', '妹', '娘', '母', '婆', '奶奶', '阿姨', 'loli', 'female'])
    expect(guessVoiceGender('cosyvoice', `game_${word}_name`)).toBe('female')
  for (const word of ['男', '少年', '正太', '叔', '爷', '哥', '弟', '父', '公子', 'shota', 'male'])
    expect(guessVoiceGender('cosyvoice', `game_${word}_name`)).toBe('male')
  expect(guessVoiceGender('cosyvoice', 'default')).toBeUndefined()
  expect(guessVoiceGender('cosyvoice', 'lolita')).toBeUndefined()
})
