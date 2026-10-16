import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { keys, useLorebook, useLorebooks, useWorldInfoSettings } from '../../api/queries'
import { BookIcon, SettingsIcon } from '../../components/icons'
import { DetailHeader, ListItem, ManagerLayout } from '../../components/layout'
import { Button } from '../../components/ui'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { BookEditor } from './BookEditor'
import { SettingsEditor } from './SettingsEditor'

const SETTINGS = 'global-settings'

export function LorebooksPage() {
  const qc = useQueryClient()
  const focusId = useUi((s) => s.focusId)
  const [selected, setSelected] = useState<string | null>(focusId)
  const [pending, setPending] = useState(false)
  const guard = useRef<() => boolean>(() => true)
  const fileInput = useRef<HTMLInputElement>(null)
  const list = useLorebooks()
  const book = useLorebook(selected === SETTINGS ? null : selected)
  const settings = useWorldInfoSettings()
  const choose = (id: string | null) => {
    if (!pending && id !== selected && guard.current()) setSelected(id)
  }
  useEffect(() => {
    if (focusId && focusId !== selected && guard.current()) setSelected(focusId)
    // 跨页定位只在目标发生变化时执行，避免本页的手动选择被覆盖。
  }, [focusId])
  const createOrImport = async (file?: File) => {
    if (pending) return
    setPending(true)
    try {
      const created = file ? await api.importLorebook(file) : await api.createLorebook({ name: '新世界书' })
      await qc.invalidateQueries({ queryKey: keys.lorebooks })
      // 网络请求期间仍可能编辑旧对象，切换前再次保护新产生的草稿。
      if (guard.current()) setSelected(created.id)
      toast.info(file ? '世界书已导入' : '世界书已创建')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setPending(false)
    }
  }
  const statusDetail = (text: string) => (
    <>
      <DetailHeader title={selected === SETTINGS ? '全局激活设置' : '世界书'} onBack={() => choose(null)} />
      <p className="p-4 text-sm text-zinc-500">{text}</p>
    </>
  )
  let detail: ReactNode = null
  if (selected === SETTINGS) {
    detail = settings.isPending ? (
      statusDetail('加载中…')
    ) : settings.isError && !settings.data ? (
      statusDetail(errorMessage(settings.error))
    ) : (
      <>
        {settings.isError && (
          <p role="alert" className="p-4 text-sm text-red-600">
            刷新失败：{errorMessage(settings.error)}
          </p>
        )}
        <SettingsEditor key={SETTINGS} settings={settings.data!} guard={guard} onBack={() => choose(null)} />
      </>
    )
  } else if (selected) {
    detail = book.isPending ? (
      statusDetail('加载中…')
    ) : book.isError && !book.data ? (
      statusDetail(errorMessage(book.error))
    ) : book.data ? (
      <>
        {book.isError && (
          <p role="alert" className="p-4 text-sm text-red-600">
            刷新失败：{errorMessage(book.error)}
          </p>
        )}
        <BookEditor
          key={selected}
          book={book.data.lorebook}
          entries={book.data.entries}
          guard={guard}
          onBack={() => choose(null)}
          onDeleted={() => setSelected(null)}
        />
      </>
    ) : (
      detail
    )
  }
  return (
    <ManagerLayout
      title="世界书"
      showDetailOnMobile={selected !== null}
      actions={
        <>
          <Button disabled={pending} onClick={() => void createOrImport()}>
            新建
          </Button>
          <Button disabled={pending} onClick={() => fileInput.current?.click()}>
            导入
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".json"
            aria-label="导入世界书 JSON（支持酒馆世界书和角色卡内嵌格式）"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void createOrImport(file)
            }}
          />
        </>
      }
      list={
        <>
          <div className="sticky top-0 z-10 mb-2 border-b border-zinc-200 bg-white pb-2 dark:border-zinc-800 dark:bg-zinc-950">
            <ListItem active={selected === SETTINGS} onClick={() => choose(SETTINGS)}>
              <SettingsIcon />
              <span>全局激活设置</span>
            </ListItem>
          </div>
          {list.isPending && <p className="p-3 text-sm text-zinc-500">加载中…</p>}
          {list.isError && (
            <p role="alert" className="p-3 text-sm text-red-600">
              {errorMessage(list.error)}
            </p>
          )}
          {list.data?.length === 0 && (
            <p className="p-3 text-sm text-zinc-500">
              还没有世界书，点击「新建」编写设定，或导入酒馆世界书 / 角色卡内嵌 JSON。
            </p>
          )}
          {list.data?.map((item) => (
            <ListItem key={item.id} active={selected === item.id} onClick={() => choose(item.id)}>
              <BookIcon />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.name}</span>
                <span className="text-xs text-zinc-500">{item.entryCount} 个条目</span>
              </span>
              {item.isGlobal && (
                <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                  全局
                </span>
              )}
            </ListItem>
          ))}
        </>
      }
      detail={detail}
    />
  )
}
