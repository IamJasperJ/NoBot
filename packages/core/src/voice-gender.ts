import type { Gender, TtsEngineId } from '@nobot/shared'

/** 供应商没有元数据时才从标识和名称推测；女性词必须先于男性词匹配。 */
export function guessVoiceGender(engine: TtsEngineId, voiceId: string, label = ''): Gender | undefined {
  if (engine === 'openai') {
    const voices: Record<string, Gender> = {
      alloy: 'neutral',
      sage: 'neutral',
      ash: 'male',
      ballad: 'male',
      echo: 'male',
      fable: 'male',
      onyx: 'male',
      verse: 'male',
      coral: 'female',
      nova: 'female',
      shimmer: 'female',
    }
    return voices[voiceId.toLowerCase()]
  }
  const text = `${voiceId} ${label}`.toLowerCase()
  // 中文类型词采用子串匹配，兼容下划线拼接的音色名；英文沿用 female/male 子串，其余词按字母边界匹配。
  // 女词先判断，既避免 female 被 male 命中，也让少女与少年按各自词语识别。
  if (/female|女|姐|萝莉|妹|娘|母|婆|奶奶|阿姨|(?:^|[^a-z])(?:girl|woman|loli)(?=$|[^a-z])/.test(text)) return 'female'
  if (/male|男|少年|正太|叔|爷|哥|弟|父|公子|(?:^|[^a-z])(?:boy|man|shota)(?=$|[^a-z])/.test(text)) return 'male'
  if (/(?:^|[^a-z])neutral(?=$|[^a-z])/.test(text)) return 'neutral'
  return undefined
}
