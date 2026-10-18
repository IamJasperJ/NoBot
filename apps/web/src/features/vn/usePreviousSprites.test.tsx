import { expect, test } from 'bun:test'
import { useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { usePreviousSprites } from './usePreviousSprites'

const sprites = [
  { id: 'a', expression: 'joy', outfit: '' },
  { id: 'b', expression: 'joy', outfit: '' },
]
const options = { expression: 'joy', outfit: '', fallback: '', random: false, seed: 'same', rerollSame: true }

test('同拍重渲染稳定、换拍避重、演员独立、离场保留、切会话清空', () => {
  const seen = new Map<number, Record<string, string | undefined>>()
  function Probe() {
    const [step, setStep] = useState(0)
    const requests =
      step === 3
        ? []
        : [
            { key: 'alice', sprites, options },
            { key: 'bob', sprites, options: { ...options, rerollSame: false } },
          ]
    const result = usePreviousSprites(step < 5 ? 'chat' : 'other', step < 2 ? 'beat-1' : `beat-${step}`, requests)
    seen.set(step, Object.fromEntries(Object.entries(result).map(([key, sprite]) => [key, sprite?.id])))
    if (step < 5) setStep(step + 1)
    return null
  }
  renderToStaticMarkup(<Probe />)
  expect(seen.get(0)).toEqual({ alice: 'a', bob: 'a' })
  expect(seen.get(1)).toEqual({ alice: 'a', bob: 'a' })
  expect(seen.get(2)).toEqual({ alice: 'b', bob: 'a' })
  expect(seen.get(3)).toEqual({})
  expect(seen.get(4)).toEqual({ alice: 'a', bob: 'a' })
  expect(seen.get(5)).toEqual({ alice: 'a', bob: 'a' })
})

test('另一个演员的立绘异步加载，不让已经显示的演员重复换图', () => {
  const seen: (string | undefined)[] = []
  function Probe() {
    const [loaded, setLoaded] = useState(false)
    const selected = usePreviousSprites('chat', 'beat', [
      { key: 'alice', sprites, options },
      { key: 'bob', sprites: loaded ? sprites : [], options },
    ])
    seen.push(selected.alice?.id)
    if (!loaded) setLoaded(true)
    return null
  }
  renderToStaticMarkup(<Probe />)
  expect(seen.every((id) => id === 'a')).toBe(true)
})
