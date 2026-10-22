import type { CharacterDTO } from '@nobot/shared'
import { t } from '../../../i18n'
import type { ImageGenRuntime } from './runtime'
import { buttonClass, errorText } from './shared'

export function createCharacterSection(runtime: ImageGenRuntime) {
  const { api, R, h } = runtime
  function CharacterSection({
    character,
    save,
  }: {
    character: CharacterDTO
    save: (patch: { extensions: Record<string, unknown> }) => Promise<void>
  }) {
    const original = character.extensions.sd_character_prompt as { positive?: string; negative?: string } | undefined
    const [positive, setPositive] = R.useState(original?.positive ?? '')
    const [negative, setNegative] = R.useState(original?.negative ?? '')
    const [busy, setBusy] = R.useState(false)
    async function submit() {
      setBusy(true)
      try {
        await save({ extensions: { ...character.extensions, sd_character_prompt: { positive, negative } } })
        api.toast.info(t('已保存角色图片提示词'))
      } catch (error) {
        api.toast.error(errorText(error))
      } finally {
        setBusy(false)
      }
    }
    return h(
      'div',
      { className: 'flex flex-col gap-3' },
      h(
        'label',
        null,
        t('角色外貌提示词（英文关键词，会加在生成提示词前面，可以写 LoRA 如 <lora:xxx:0.8>）'),
        h('textarea', {
          'aria-label': t('角色外貌提示词'),
          className: 'mt-1 w-full rounded border bg-transparent p-2',
          rows: 4,
          value: positive,
          onChange: (event: { target: { value: string } }) => setPositive(event.target.value),
        }),
      ),
      h(
        'label',
        null,
        t('角色负面提示词'),
        h('textarea', {
          'aria-label': t('角色负面提示词'),
          className: 'mt-1 w-full rounded border bg-transparent p-2',
          rows: 3,
          value: negative,
          onChange: (event: { target: { value: string } }) => setNegative(event.target.value),
        }),
      ),
      h('button', { type: 'button', className: buttonClass, disabled: busy, onClick: submit }, t('保存图片提示词')),
    )
  }
  return CharacterSection
}
