import { expect, test } from 'bun:test'
import { useVn } from './vn'

test('电影模式首次切换按预设取反，后续按会话保留在内存', () => {
  const previous = useVn.getState().cinema
  try {
    useVn.setState({ cinema: {} })
    useVn.getState().toggleCinema('letterbox-on', true)
    expect(useVn.getState().cinema['letterbox-on']).toBe(false)
    useVn.getState().toggleCinema('letterbox-off', false)
    expect(useVn.getState().cinema['letterbox-off']).toBe(true)
    useVn.getState().toggleCinema('letterbox-on', true)
    expect(useVn.getState().cinema['letterbox-on']).toBe(true)
    expect(useVn.getState().cinema['letterbox-off']).toBe(true)
    useVn.getState().toggleCinema('default')
    expect(useVn.getState().cinema.default).toBe(true)
  } finally {
    useVn.setState({ cinema: previous })
  }
})
