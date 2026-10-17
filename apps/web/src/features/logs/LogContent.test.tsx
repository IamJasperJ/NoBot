/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CollapsibleContent } from './LogContent'

const render = (content: string) => renderToStaticMarkup(<CollapsibleContent content={content} />)

describe('日志内容展开', () => {
  test('空内容、短内容和阈值内内容完整显示，不提供展开按钮', () => {
    for (const content of ['', '短消息', '字'.repeat(300), Array(6).fill('一行').join('\n')]) {
      const html = render(content)
      expect(html).not.toContain('展开全文')
      expect(html).not.toContain('max-h-36')
      expect(html).toContain(content || '（空内容）')
    }
  })

  test('超过 300 字或 6 行的内容折叠，并提供展开按钮', () => {
    for (const content of ['字'.repeat(301), Array(7).fill('一行').join('\n'), Array(7).fill('一行').join('\r\n')]) {
      const html = render(content)
      expect(html).toContain('展开全文')
      expect(html).toContain('aria-expanded="false"')
      expect(html).toContain('max-h-36')
    }
  })
})
