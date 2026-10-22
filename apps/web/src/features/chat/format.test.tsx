import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FormattedText } from './format'

test('聊天渲染隐藏应用标签并保留成对正文和真实括号', () => {
  for (const text of [
    '普通。<whisper>秘密。</whisper>恢复。<pause ms="500"/><sniff/><foobar/>（小声）',
    'Normal.<whisper>Secret.</whisper>Back.[whispers][pause]<inhale/><foobar/>(quietly)',
  ]) {
    const html = renderToStaticMarkup(<FormattedText text={text} />)
    expect(html).toContain(text.startsWith('普通') ? '普通。秘密。恢复。（小声）' : 'Normal.Secret.Back.(quietly)')
    for (const control of ['whisper', 'pause', 'sniff', 'inhale', 'foobar']) expect(html).not.toContain(control)
  }
})
