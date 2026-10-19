import { expect, test } from 'bun:test'
import { applyStageOps, emptyStage, matchByName, parseStageMessage } from './index'

const opts = { knownNames: [], vars: {}, inline: false, mvu: false }
test('名字优先完全匹配，再选最长包含，不修改原数组', () => {
  const items = ['Night', 'Night Forest', 'FOREST'].map((name) => ({ name }))
  expect(matchByName(' forest ', items)?.name).toBe('FOREST')
  expect(matchByName('night forest rain', items)?.name).toBe('Night Forest')
  expect(matchByName('nigh', items)?.name).toBe('Night Forest')
  expect(matchByName('', items)).toBeUndefined()
  expect(matchByName('unknown', items)).toBeUndefined()
  expect(items[0]?.name).toBe('Night')
})
test.each(['<bgm name="Night" />', "<BGM NAME='Night'></BGM>", '<bgm name=Night>'])(
  'BGM 转成文中位置的舞台拍：%s',
  (tag) => {
    const { stage } = parseStageMessage(`Before\n${tag}\nAfter`, opts)
    expect(stage.beats).toEqual([
      { kind: 'narration', text: 'Before' },
      { kind: 'stage', ops: [{ op: 'scene', bgm: 'Night' }] },
      { kind: 'narration', text: 'After' },
    ])
  },
)
test.each(['none', 'STOP', ' off ', ''])('BGM 停止值规范化且不混淆缺省：%s', (name) => {
  for (const tag of [`<bgm name="${name}" />`, `<scene bgm="${name}" />`]) {
    const { stage } = parseStageMessage(tag, opts)
    expect(stage.ops).toEqual([{ op: 'scene', bgm: '' }])
    const playing = applyStageOps(emptyStage(), [{ op: 'scene', bgm: 'Night' }])
    expect(applyStageOps(playing, stage.ops).scene.bgm).toBe('')
    expect(applyStageOps(playing, [{ op: 'scene', place: 'room' }]).scene.bgm).toBe('Night')
  }
})
