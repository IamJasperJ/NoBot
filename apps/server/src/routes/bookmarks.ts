import { updateBookmarkInput } from '@ai-parter/shared'
import { Hono } from 'hono'
import { validate } from '../lib/validate'
import * as bookmarks from '../services/bookmarks'

export const bookmarkRoutes = new Hono()
  .patch('/:id', validate('json', updateBookmarkInput), (c) =>
    c.json(bookmarks.renameBookmark(c.req.param('id'), c.req.valid('json').name)),
  )
  .delete('/:id', (c) => {
    bookmarks.deleteBookmark(c.req.param('id'))
    return c.json({ ok: true })
  })
