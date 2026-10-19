import { expect, spyOn, test } from 'bun:test'
import { type PlayPresetData, playPresetDataSchema } from '@nobot/shared'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useStageTransition, useSyncStageTransition } from './vn'

test('预设切换同步转场，未启用舞台指令和未加载时恢复默认', () => {
  const previous = useStageTransition.getState().value
  const effect = spyOn(React, 'useEffect').mockImplementation((callback) => {
    callback()
  })
  function render(play?: PlayPresetData) {
    function Probe() {
      useSyncStageTransition(play)
      return null
    }
    renderToStaticMarkup(<Probe />)
    return useStageTransition.getState().value
  }
  try {
    const play = playPresetDataSchema.parse({})
    play.directives.enabled = true
    for (const kind of ['fade', 'none', 'dissolve'] as const) {
      play.stage.transition = kind
      play.stage.transitionMs = 750
      expect(render(play)).toEqual({ kind, ms: 750 })
    }
    play.directives.enabled = false
    expect(render(play)).toEqual({ kind: 'dissolve', ms: 300 })
    expect(render()).toEqual({ kind: 'dissolve', ms: 300 })
  } finally {
    effect.mockRestore()
    useStageTransition.getState().set(previous)
  }
})
