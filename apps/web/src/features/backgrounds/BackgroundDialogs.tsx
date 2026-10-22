import type { BackgroundDTO, NameBackgroundsResult } from '@nobot/shared'
import { useState } from 'react'
import { api } from '../../api/client'
import { useAiNameBackgrounds, useCreateBackgroundFolder, useUpdateBackgroundFolder } from '../../api/queries'
import { TextAreaField, TextField } from '../../components/form'
import { WandIcon } from '../../components/icons'
import { Button, Dialog } from '../../components/ui'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'

type Run = (action: () => Promise<unknown>) => Promise<void>

/** 批量命名的结果：成功几张，失败的提示第一条原因 */
export function reportAiName(result: NameBackgroundsResult) {
  if (result.items.length) toast.info(t('已为 {count} 张背景起名', { count: result.items.length }))
  if (result.failed.length)
    toast.error(t('{count} 张起名失败：{error}', { count: result.failed.length, error: result.failed[0]?.error ?? '' }))
}

/** 新建 / 重命名文件夹；id 为空表示新建 */
export function FolderDialog({
  value,
  onChange,
  onClose,
}: {
  value: { id: string | null; name: string } | null
  onChange: (value: { id: string | null; name: string }) => void
  onClose: () => void
}) {
  const createFolder = useCreateBackgroundFolder()
  const updateFolder = useUpdateBackgroundFolder()
  return (
    <Dialog open={!!value} onClose={onClose} title={value?.id ? t('重命名文件夹') : t('新建文件夹')}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (!value?.name.trim()) return
          const name = value.name.trim()
          const done = { onError: (e: unknown) => toast.error(errorMessage(e)), onSuccess: onClose }
          if (value.id) updateFolder.mutate({ id: value.id, input: { name } }, done)
          else createFolder.mutate({ name }, done)
        }}
      >
        <TextField
          label={t('文件夹名')}
          value={value?.name ?? ''}
          onChange={(name) => value && onChange({ ...value, name })}
        />
        <Button type="submit" variant="primary" disabled={!value?.name.trim()}>
          {t('保存')}
        </Button>
      </form>
    </Dialog>
  )
}

/** 从网址添加背景 */
export function ImportUrlDialog({
  open,
  busy,
  run,
  onClose,
}: {
  open: boolean
  busy: boolean
  run: Run
  onClose: () => void
}) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  return (
    <Dialog open={open} onClose={onClose} title={t('从网址添加背景')}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void run(async () => {
            await api.importBackgroundUrl({ url: url.trim(), ...(name.trim() ? { name: name.trim() } : {}) })
            onClose()
            setUrl('')
            setName('')
            toast.info(t('背景已添加'))
          })
        }}
      >
        <TextField label={t('背景网址（http/https）')} value={url} onChange={setUrl} />
        <TextField label={t('名称（可选）')} value={name} onChange={setName} />
        <Button type="submit" variant="primary" disabled={busy || !url.trim()}>
          {busy ? t('添加中…') : t('添加')}
        </Button>
      </form>
    </Dialog>
  )
}

/** 编辑背景的名字和描述，可以让看图模型先填一份 */
export function EditBackgroundDialog({
  current,
  busy,
  run,
  onClose,
}: {
  current: BackgroundDTO
  busy: boolean
  run: Run
  onClose: () => void
}) {
  const [name, setName] = useState(current.name)
  const [description, setDescription] = useState(current.description)
  const aiName = useAiNameBackgrounds()
  return (
    <Dialog open onClose={onClose} title={t('编辑背景')}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim())
            void run(async () => {
              await api.updateBackground(current.id, { name: name.trim(), description: description.trim() })
              onClose()
            })
        }}
      >
        <TextField
          label={t('名字')}
          hint={t('模型用场景指令换背景时按名字匹配，写地点最好用（比如「黄昏的酒馆」）')}
          value={name}
          onChange={setName}
        />
        <TextAreaField
          label={t('描述')}
          hint={t('一句话描述画面：地点、时间、氛围。会和名字一起出现在给模型的背景清单里')}
          rows={3}
          value={description}
          onChange={setDescription}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy || aiName.isPending || !name.trim()}>
            {t('保存')}
          </Button>
          <Button
            disabled={busy || aiName.isPending || current.mime.startsWith('video/')}
            title={t('让看图模型根据画面起名并写描述，填进表单后由你决定是否保存')}
            onClick={() =>
              aiName.mutate(
                { ids: [current.id], apply: false },
                {
                  onError: (e: unknown) => toast.error(errorMessage(e)),
                  onSuccess: (result) => {
                    const item = result.items[0]
                    if (item) {
                      setName(item.name)
                      setDescription(item.description)
                    } else reportAiName(result)
                  },
                },
              )
            }
          >
            <WandIcon />
            {aiName.isPending ? t('正在看图…') : t('AI 起名')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
