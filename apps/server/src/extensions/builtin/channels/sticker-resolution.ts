import type { ChannelStickerDTO } from '@nobot/shared'

// 只做有限同义词映射；不猜测无关的表情，也不额外请求模型。
export const STICKER_EMOTIONS = [
  ['😊', '🙂', '😄', 'happy', 'smile', '开心', '微笑', '快乐', 'grin', '呲牙'],
  ['😂', '🤣', 'laugh', '笑', '狂笑', '大笑', 'giggle', '偷笑'],
  ['😢', '😭', 'sad', 'cry', 'tears', '难过', '哭', '流泪', '大哭'],
  ['😠', '😡', 'angry', 'mad', '生气', '发怒'],
  ['❤️', '❤', '🥰', 'love', '爱', '喜欢', 'heart eyes'],
  ['😏', 'smirk', '坏笑', '得意', 'sly smile'],
  ['🙈', '😳', 'shy', '害羞'],
  ['🤦', '🤦‍♂️', '🤦‍♀️', 'facepalm', '捂脸', '无语'],
  ['😮', '😲', 'surprised', '惊讶'],
  ['🤔', 'confused', 'question', '疑问', '问号脸'],
  ['😴', 'sleep', 'sleepy', '困', '睡'],
  ['🙏', 'thanks', 'thank you', '谢谢', '拜谢', 'please', '拜托'],
] as const
const normalize = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/\ufe0f/g, '')
const emotion = (text: string) =>
  STICKER_EMOTIONS.findIndex((row) => row.some((value) => normalize(value) === normalize(text)))
export function resolveSticker<T extends Pick<ChannelStickerDTO, 'meanings' | 'characters'>>(
  entries: T[],
  mood: string,
  random: () => number = Math.random,
): T | undefined {
  const exact = entries.filter((entry) => entry.meanings.some((meaning) => normalize(meaning) === normalize(mood)))
  const key = emotion(mood)
  const matches = exact.length
    ? exact
    : key < 0
      ? []
      : entries.filter((entry) => entry.meanings.some((meaning) => emotion(meaning) === key))
  const exclusive = matches.filter((entry) => entry.characters.length)
  const pool = exclusive.length ? exclusive : matches
  return pool[Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)))]
}
