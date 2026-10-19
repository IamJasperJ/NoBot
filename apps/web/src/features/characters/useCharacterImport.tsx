import type { CharacterDTO, CharacterImportLorebook, CharacterImportPreview } from '@nobot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { keys } from '../../api/queries'
import { Button, Dialog } from '../../components/ui'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'

type Decision = { lorebook: CharacterImportLorebook; remember: boolean }
type Pending = { preview: CharacterImportPreview; multiple: boolean }
const options = (): { value: CharacterImportLorebook; label: string }[] => [
  { value: 'link', label: t('导入并关联到角色（推荐）') },
  { value: 'import', label: t('只导入世界书，不关联') },
  { value: 'skip', label: t('不导入世界书') },
]

/** 两个导入入口共用串行预读与确认，批量选择只在本次文件列表内生效。 */
export function useCharacterImport(onImported?: (character: CharacterDTO) => void) {
  const qc = useQueryClient()
  const [importing, setImporting] = useState(false)
  const locked = useRef(false)
  const mounted = useRef(true)
  const [pending, setPending] = useState<Pending | null>(null)
  const [choice, setChoice] = useState<CharacterImportLorebook>('skip')
  const [remember, setRemember] = useState(false)
  const resolve = useRef<((decision: Decision | null) => void) | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      resolve.current?.(null)
      resolve.current = null
    }
  }, [])

  const finish = (decision: Decision | null) => {
    const next = resolve.current
    resolve.current = null
    setPending(null)
    next?.(decision)
  }

  const importFiles = async (files: File[]) => {
    if (locked.current || files.length === 0) return
    locked.current = true
    setImporting(true)
    let remembered: CharacterImportLorebook | undefined
    try {
      for (const file of files) {
        if (!mounted.current) break
        try {
          const preview = await api.previewCharacterImport(file)
          if (!mounted.current) break
          let lorebook: CharacterImportLorebook = 'skip'
          if (preview.lorebook) {
            if (remembered) lorebook = remembered
            else {
              setChoice('skip')
              setRemember(false)
              const decision = await new Promise<Decision | null>((next) => {
                resolve.current = next
                setPending({ preview, multiple: files.length > 1 })
              })
              if (!decision) continue
              lorebook = decision.lorebook
              if (decision.remember) remembered = lorebook
            }
          }
          const character = await api.importCharacter(file, lorebook)
          toast.info(t('已导入「{name}」', { name: character.name }))
          if (mounted.current) onImported?.(character)
        } catch (error) {
          toast.error(`${file.name}：${errorMessage(error)}`)
        }
      }
    } finally {
      try {
        await Promise.all([
          qc.invalidateQueries({ queryKey: keys.characters }),
          qc.invalidateQueries({ queryKey: keys.lorebooks }),
        ])
      } catch (error) {
        toast.error(errorMessage(error))
      } finally {
        locked.current = false
        if (mounted.current) setImporting(false)
      }
    }
  }

  const importDialog = (
    <Dialog open={pending !== null} onClose={() => finish(null)} title={t('导入角色卡中的世界书')}>
      {pending && (
        <div className="space-y-4">
          <p className="break-words">
            {t('角色「{characterName}」内嵌世界书「{lorebookName}」，共 {count} 个条目。', {
              characterName: pending.preview.name,
              lorebookName: pending.preview.lorebook?.name ?? '',
              count: pending.preview.lorebook?.entryCount ?? '',
            })}
          </p>
          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-medium">{t('请选择世界书的处理方式')}</legend>
            {options().map((option) => (
              <label key={option.value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="character-import-lorebook"
                  value={option.value}
                  checked={choice === option.value}
                  onChange={() => setChoice(option.value)}
                />
                {option.label}
              </label>
            ))}
          </fieldset>
          {pending.multiple && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              {t('后面的角色卡都这样处理')}
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={() => finish(null)}>{t('跳过这张角色卡')}</Button>
            <Button variant="primary" onClick={() => finish({ lorebook: choice, remember })}>
              {t('确认导入')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  )

  return { importing, importFiles, importDialog }
}
