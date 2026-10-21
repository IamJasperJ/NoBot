import { expect, spyOn, test } from 'bun:test'
import { type CharacterDTO, characterInput } from '@nobot/shared'
import * as React from 'react'
import { CharacterVoiceSection } from './TtsUi'
import { VoicePicker } from './VoicePicker'

function find(node: React.ReactNode, type: unknown): React.ReactElement<Record<string, unknown>> | undefined {
  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return
  if (node.type === type) return node as React.ReactElement<Record<string, unknown>>
  for (const child of React.Children.toArray(node.props.children)) {
    const found = find(child, type)
    if (found) return found
  }
}

test('角色声音仅提交当前键，清空风格和不设置声音显式传删除标记', async () => {
  const character: CharacterDTO = {
    ...characterInput.parse({ name: '角色', extensions: { nobot_tts_style: 'soft', other: true } }),
    id: 'character',
    avatarUrl: null,
    createdAt: 0,
    updatedAt: 0,
  }
  const patches: { extensions: Record<string, unknown> }[] = []
  let index = 0
  const state = spyOn(React, 'useState').mockImplementation((() => {
    const value = [null, false, '   '][index++]
    return [value, () => {}]
  }) as typeof React.useState)
  try {
    const tree = CharacterVoiceSection({
      character,
      save: async (patch) => {
        patches.push(patch)
      },
    })
    const textarea = find(tree, 'textarea')
    const picker = find(tree, VoicePicker)
    if (!textarea || !picker) throw new Error('缺少角色声音控件')
    await (textarea.props.onBlur as () => Promise<void>)()
    expect(patches).toEqual([{ extensions: { nobot_tts_style: null } }])
    await (picker.props.onChange as (value: null) => Promise<void>)(null)
    expect(patches[1]).toEqual({ extensions: { nobot_tts: null } })
  } finally {
    state.mockRestore()
  }
})
